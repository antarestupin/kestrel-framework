import { defaultMaxErrorBodyBytes, defaultMaxResponseBytes } from "./defaults.js";
import { OutboundHttpBodies, validateResponseLimit } from "./body.js";
import { OutboundHttpDeadline } from "./deadline.js";
import {
  OutboundHttpAbortedError,
  OutboundHttpDecodeError,
  OutboundHttpResponseError,
  OutboundHttpResponseTooLargeError,
  OutboundHttpTimeoutError,
  OutboundHttpTransportError,
} from "./errors.js";
import {
  orderOutboundHttpMiddleware,
  runOutboundHttpMiddleware,
} from "./middleware.js";
import type {
  OutboundHttpInstrumentationEvent,
  OutboundHttpResult,
} from "./observations.js";
import type {
  OutboundHttpBodyRequestOptions,
  OutboundHttpClientOptions,
  OutboundHttpFetchOptions,
  OutboundHttpFetch,
  OutboundHttpInput,
  OutboundHttpPathParameters,
  OutboundHttpQuery,
  OutboundHttpQueryValue,
  OutboundHttpRequestDefinition,
  OutboundHttpRequestOptions,
  OutboundHttpResponseDecoder,
} from "./types.js";

interface RequestExecutionState {
  attempts: number;
}

/** Server-only HTTP facade built on the native fetch contracts. */
export class OutboundHttpClient {
  private readonly name: string;

  private readonly baseUrl: URL | undefined;

  private readonly fetchImplementation: typeof globalThis.fetch;

  private readonly monotonicNow: () => number;

  public constructor(private readonly options: OutboundHttpClientOptions) {
    validateTimeout(options.timeoutMs);
    validateResponseLimit(options.maxResponseBytes ?? defaultMaxResponseBytes);
    validateResponseLimit(options.maxErrorBodyBytes ?? defaultMaxErrorBodyBytes);
    this.name = normalizeName(options.name);
    this.baseUrl = options.baseUrl === undefined
      ? undefined
      : normalizeBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());

    if (this.fetchImplementation === undefined) {
      throw new TypeError("An outbound HTTP fetch implementation is required.");
    }
  }

  /** Executes one native request through ordered client and request middleware. */
  public async fetch(
    input: OutboundHttpInput,
    options: OutboundHttpFetchOptions = {},
  ): Promise<Response> {
    return this.execute(input, options);
  }

  /** Own the logical deadline until decoding ends or streaming ownership transfers. */
  private async execute<Output = Response>(
    input: OutboundHttpInput,
    options: OutboundHttpFetchOptions,
    structured = false,
    decoder?: OutboundHttpResponseDecoder<Output>,
  ): Promise<Output> {
    const {
      middleware: requestMiddleware = [],
      operation: configuredOperation,
      route: configuredRoute,
      timeoutMs = this.options.timeoutMs,
      maxResponseBytes = this.options.maxResponseBytes ?? defaultMaxResponseBytes,
      maxErrorBodyBytes = this.options.maxErrorBodyBytes ?? defaultMaxErrorBodyBytes,
      ...requestInit
    } = options;
    validateTimeout(timeoutMs);
    validateResponseLimit(maxResponseBytes);
    validateResponseLimit(maxErrorBodyBytes);
    const url = this.resolveUrl(input);
    // Raw URLs may contain identifiers, so only an explicit template is safe.
    const route = normalizeRoute(configuredRoute ?? "request");
    const method = normalizeMethod(
      requestInit.method ?? (input instanceof Request ? input.method : "GET"),
    );
    const operation = normalizeOperation(
      configuredOperation ?? `${this.name}.${method}.${route}`,
    );
    const baseSignal = requestInit.signal
      ?? (input instanceof Request ? input.signal : undefined);
    const deadline = new OutboundHttpDeadline(operation, timeoutMs, baseSignal);
    const bodies = new OutboundHttpBodies(
      operation, deadline, maxResponseBytes, structured ? maxErrorBodyBytes : undefined,
    );
    let retainedResponse: Response | undefined;
    let responseStatus: number | undefined;
    const state: RequestExecutionState = { attempts: 0 };
    const startedAt = this.measureTime();

    try {
      const request = await deadline.run(() => this.createRequest(input, url, {
        ...requestInit,
        method,
        signal: deadline.signal,
      }));
      const middleware = orderOutboundHttpMiddleware([
        ...(this.options.middleware ?? []),
        ...requestMiddleware,
      ]);
      const response = await deadline.run(
        () => runOutboundHttpMiddleware(
          middleware,
          {
            client: this.name,
            operation,
            route,
            request,
            attempt: 1,
            maxResponseBytes,
          },
          (context) => this.executeAttempt(context, state, deadline, bodies),
          // Every middleware boundary also protects synthetic and cached responses.
          (response) => bodies.protect(response),
          () => deadline.check(),
        ),
      );

      responseStatus = response.status;
      let output: Output;
      if (structured && !response.ok) {
        throw new OutboundHttpResponseError(
          operation, response.status, response.statusText,
          await deadline.run(() => readErrorBody(response, bodies)),
        );
      }
      if (decoder === undefined) {
        output = response as Output;
      } else {
        output = await deadline.run(() => this.decode(operation, decoder, response, deadline));
      }
      bodies.check();
      if (decoder === undefined || decoder.lifetime === "stream") retainedResponse = response;

      this.record({
        type: "request",
        outcome: response.ok ? "success" : "failure",
        durationMs: duration(startedAt, this.measureTime()),
        data: {
          client: this.name,
          operation,
          method,
          route,
          result: "response",
          attempts: state.attempts,
          status: response.status,
        },
      });

      return output;
    } catch (error: unknown) {
      const normalizedError = normalizePipelineError(
        error,
        deadline,
      );
      const result = classifyError(normalizedError);

      this.record({
        type: "request",
        outcome: "failure",
        durationMs: duration(startedAt, this.measureTime()),
        data: {
          client: this.name,
          operation,
          method,
          route,
          result,
          attempts: state.attempts,
          ...(responseStatus === undefined ? {} : { status: responseStatus }),
        },
      });

      throw normalizedError;
    } finally {
      bodies.close(retainedResponse);
      deadline.close();
    }
  }

  /** Executes one structured request and decodes its successful response. */
  public async request<Output = Response>(
    definition: OutboundHttpRequestDefinition<Output>,
  ): Promise<Output> {
    const {
      body,
      headers: configuredHeaders,
      json,
      method,
      middleware,
      operation: configuredOperation,
      path: pathParameters,
      pathTemplate,
      query,
      response: decoder,
      timeoutMs,
      ...requestInit
    } = definition;

    if (body !== undefined && json !== undefined) {
      throw new TypeError("An outbound HTTP request cannot define both body and json.");
    }

    validatePathTemplate(pathTemplate);
    const path = interpolatePath(pathTemplate, pathParameters);
    const url = appendQuery(this.resolveUrl(path), query);
    const operation = normalizeOperation(
      configuredOperation
        ?? `${this.name}.${normalizeMethod(method)}.${normalizeRoute(pathTemplate)}`,
    );
    const headers = new Headers(configuredHeaders);
    let serializedBody = body;

    if (json !== undefined) {
      serializedBody = JSON.stringify(json);

      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }

    return this.execute(url, {
      ...requestInit,
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      operation,
      route: pathTemplate,
      ...(middleware === undefined ? {} : { middleware }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }, true, decoder);
  }

  public get<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "GET", pathTemplate });
  }

  public head<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "HEAD", pathTemplate });
  }

  public post<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpBodyRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "POST", pathTemplate });
  }

  public put<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpBodyRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "PUT", pathTemplate });
  }

  public patch<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpBodyRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "PATCH", pathTemplate });
  }

  public delete<Output = Response>(
    pathTemplate: string,
    options: OutboundHttpBodyRequestOptions<Output> = {},
  ): Promise<Output> {
    return this.request({ ...options, method: "DELETE", pathTemplate });
  }

  private async createRequest(
    input: OutboundHttpInput,
    url: URL,
    init: RequestInit,
  ): Promise<Request> {
    const sharedHeaders = typeof this.options.headers === "function"
      ? await this.options.headers()
      : this.options.headers;
    const headers = new Headers(sharedHeaders);
    const inputHeaders = input instanceof Request ? input.headers : undefined;

    applyHeaders(headers, inputHeaders);
    applyHeaders(headers, init.headers);

    return new Request(input instanceof Request ? input : url, {
      ...init,
      headers,
    });
  }

  private async executeAttempt(
    context: {
      client: string;
      operation: string;
      route: string;
      request: Request;
      attempt: number;
    },
    state: RequestExecutionState,
    deadline: OutboundHttpDeadline,
    bodies: OutboundHttpBodies,
  ): Promise<Response> {
    state.attempts += 1;
    const startedAt = this.measureTime();

    try {
      deadline.check();
      // Preserve the execution signal even when middleware replaces the Request.
      const request = new Request(context.request, {
        signal: AbortSignal.any([context.request.signal, deadline.signal]),
      });
      const response = await deadline.run(async () =>
        bodies.protect(await this.fetchImplementation(request)));

      this.record({
        type: "attempt",
        outcome: response.ok ? "success" : "failure",
        durationMs: duration(startedAt, this.measureTime()),
        data: {
          client: context.client,
          operation: context.operation,
          method: context.request.method,
          route: context.route,
          result: "response",
          attempt: context.attempt,
          status: response.status,
        },
      });

      return response;
    } catch (error: unknown) {
      const normalizedError = normalizeFetchError(
        error,
        context.operation,
        context.request.signal,
        deadline,
      );

      this.record({
        type: "attempt",
        outcome: "failure",
        durationMs: duration(startedAt, this.measureTime()),
        data: {
          client: context.client,
          operation: context.operation,
          method: context.request.method,
          route: context.route,
          result: classifyError(normalizedError),
          attempt: context.attempt,
        },
      });

      throw normalizedError;
    }
  }

  private async decode<Output>(
    operation: string,
    decoder: OutboundHttpResponseDecoder<Output>,
    response: Response,
    deadline: OutboundHttpDeadline,
  ): Promise<Output> {
    try {
      return await decoder.decode(response, { signal: deadline.signal });
    } catch (error: unknown) {
      if (error instanceof OutboundHttpResponseTooLargeError
        || error instanceof OutboundHttpTimeoutError
        || error instanceof OutboundHttpAbortedError) throw error;
      throw new OutboundHttpDecodeError(operation, decoder.description, {
        cause: error,
      });
    }
  }

  private resolveUrl(input: OutboundHttpInput): URL {
    if (input instanceof Request) {
      return new URL(input.url);
    }

    try {
      return this.baseUrl === undefined
        ? new URL(input)
        : new URL(String(input), this.baseUrl);
    } catch (error: unknown) {
      throw new TypeError(
        "A relative outbound HTTP URL requires a configured baseUrl.",
        { cause: error },
      );
    }
  }

  private measureTime(): number | undefined {
    if (this.options.instrumentation === undefined) return undefined;

    try {
      return this.monotonicNow();
    } catch {
      return undefined;
    }
  }

  private record(event: OutboundHttpInstrumentationEvent): void {
    try {
      this.options.instrumentation?.record(event);
    } catch {
      // Diagnostics cannot alter HTTP request semantics.
    }
  }
}

/** Creates the structured outbound client used by dedicated API classes. */
export function createOutboundHttpClient(
  options: OutboundHttpClientOptions,
): OutboundHttpClient {
  return new OutboundHttpClient(options);
}

/** Creates the low-level fetch surface backed by the same middleware engine. */
export function createOutboundFetch(
  options: OutboundHttpClientOptions,
): OutboundHttpFetch {
  const client = new OutboundHttpClient(options);

  return (input, requestOptions) => client.fetch(input, requestOptions);
}

function normalizeFetchError(
  error: unknown,
  operation: string,
  signal: AbortSignal,
  deadline: OutboundHttpDeadline,
): Error {
  if (deadline.signal.aborted) return deadline.error();

  if (error instanceof OutboundHttpTimeoutError) return error;

  if (signal.aborted) {
    return new OutboundHttpAbortedError(operation, { cause: signal.reason });
  }

  if (error instanceof OutboundHttpAbortedError
    || error instanceof OutboundHttpTransportError) {
    return error;
  }

  return new OutboundHttpTransportError(operation, { cause: error });
}

function normalizePipelineError(
  error: unknown,
  deadline: OutboundHttpDeadline,
): unknown {
  if (!deadline.signal.aborted) return error;

  return deadline.error();
}

function classifyError(error: unknown): OutboundHttpResult {
  if (error instanceof OutboundHttpTimeoutError) return "timeout";
  if (error instanceof OutboundHttpAbortedError) return "aborted";
  if (!(error instanceof OutboundHttpTransportError)) return "error";

  return "network-error";
}

function interpolatePath(
  template: string,
  parameters: OutboundHttpPathParameters | undefined,
): string {
  const used = new Set<string>();
  const path = template.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;

    const name = segment.slice(1);
    const value = parameters?.[name];

    if (value === undefined) {
      throw new TypeError(`Outbound HTTP path parameter "${name}" is required.`);
    }

    used.add(name);
    return encodeURIComponent(serializeScalar(value));
  }).join("/");

  for (const name of Object.keys(parameters ?? {})) {
    if (!used.has(name)) {
      throw new TypeError(`Outbound HTTP path parameter "${name}" does not exist in route "${template}".`);
    }
  }

  return path;
}

function validatePathTemplate(template: string): void {
  const normalized = template.trim();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP path template cannot be empty.");
  }

  if (normalized.includes("?") || normalized.includes("#")) {
    throw new TypeError("Outbound HTTP query and fragment values must not be embedded in a path template.");
  }

  if (normalized.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(normalized)) {
    throw new TypeError("A structured outbound HTTP path template must be relative to its client baseUrl.");
  }
}

function appendQuery(url: URL, query: OutboundHttpQuery | undefined): URL {
  if (query === undefined) return url;

  const result = new URL(url);

  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) appendQueryValue(result, name, item);
    } else {
      appendQueryValue(result, name, value as OutboundHttpQueryValue);
    }
  }

  return result;
}

function appendQueryValue(
  url: URL,
  name: string,
  value: OutboundHttpQueryValue,
): void {
  if (value === undefined || value === null) return;

  url.searchParams.append(name, serializeScalar(value));
}

function serializeScalar(value: boolean | Date | number | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function readErrorBody(response: Response, bodies: OutboundHttpBodies): Promise<unknown> {
  const text = await response.text();
  const truncated = bodies.truncated(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (truncated) return { truncated: true, text };
  if (text !== "" && (contentType.includes("application/json") || contentType.includes("+json"))) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Malformed HTTP error bodies retain the original diagnostic text.
    }
  }
  return text;
}

function applyHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (source === undefined) return;

  new Headers(source).forEach((value, name) => target.set(name, value));
}

function normalizeBaseUrl(value: string | URL): URL {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("An outbound HTTP baseUrl must use HTTP or HTTPS.");
  }

  return url;
}

function normalizeName(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP client name cannot be empty.");
  }

  return normalized;
}

function normalizeOperation(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP operation cannot be empty.");
  }

  return normalized;
}

function normalizeRoute(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP route cannot be empty.");
  }

  return normalized;
}

function normalizeMethod(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP method cannot be empty.");
  }

  return normalized;
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined
    && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError("An outbound HTTP timeout must be positive and finite.");
  }
}

function duration(startedAt: number | undefined, endedAt: number | undefined): number {
  return startedAt === undefined || endedAt === undefined
    ? 0
    : Math.max(0, endedAt - startedAt);
}
