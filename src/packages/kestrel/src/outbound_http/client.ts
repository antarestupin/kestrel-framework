import {
  OutboundHttpAbortedError,
  OutboundHttpDecodeError,
  OutboundHttpResponseError,
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

interface Deadline {
  readonly signal: AbortSignal;
  readonly timeoutError?: OutboundHttpTimeoutError;
  run<Value>(operation: Promise<Value>): Promise<Value>;
  close(): void;
}

const maximumErrorBodyBytes = 64 * 1_024;

/** Server-only HTTP facade built on the native fetch contracts. */
export class OutboundHttpClient {
  private readonly name: string;

  private readonly baseUrl: URL | undefined;

  private readonly fetchImplementation: typeof globalThis.fetch;

  private readonly monotonicNow: () => number;

  public constructor(private readonly options: OutboundHttpClientOptions) {
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
    const {
      middleware: requestMiddleware = [],
      operation: configuredOperation,
      route: configuredRoute,
      timeoutMs,
      ...requestInit
    } = options;
    validateTimeout(timeoutMs);
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
    const deadline = createDeadline(operation, timeoutMs, baseSignal);
    const state: RequestExecutionState = { attempts: 0 };
    const startedAt = this.measureTime();

    try {
      const request = await deadline.run(this.createRequest(input, url, {
        ...requestInit,
        method,
        signal: deadline.signal,
      }));
      const middleware = orderOutboundHttpMiddleware([
        ...(this.options.middleware ?? []),
        ...requestMiddleware,
      ]);
      const response = await deadline.run(
        runOutboundHttpMiddleware(
          middleware,
          {
            client: this.name,
            operation,
            route,
            request,
            attempt: 1,
          },
          (context) => this.executeAttempt(context, state, deadline),
        ),
      );

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

      return response;
    } catch (error: unknown) {
      const normalizedError = normalizePipelineError(
        error,
        operation,
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
        },
      });

      throw normalizedError;
    } finally {
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

    const response = await this.fetch(url, {
      ...requestInit,
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      operation,
      route: pathTemplate,
      ...(middleware === undefined ? {} : { middleware }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

    if (!response.ok) {
      throw new OutboundHttpResponseError(
        operation,
        response.status,
        response.statusText,
        await readErrorBody(response),
      );
    }

    if (decoder === undefined) {
      return response as Output;
    }

    return this.decode(operation, decoder, response);
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
    deadline: Deadline,
  ): Promise<Response> {
    state.attempts += 1;
    const startedAt = this.measureTime();

    try {
      const response = await this.fetchImplementation(context.request);

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
  ): Promise<Output> {
    try {
      return await decoder.decode(response);
    } catch (error: unknown) {
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

function createDeadline(
  operation: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | null | undefined,
): Deadline {
  if (timeoutMs === undefined) {
    return {
      signal: signal ?? new AbortController().signal,
      run: (operation) => operation,
      close: () => {},
    };
  }

  const controller = new AbortController();
  const timeoutError = new OutboundHttpTimeoutError(operation, timeoutMs);
  const expiration = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    expiration.reject(timeoutError);
  }, timeoutMs);
  timeout.unref();

  return {
    signal: signal === undefined || signal === null
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]),
    timeoutError,
    run: (operationPromise) => Promise.race([
      operationPromise,
      expiration.promise,
    ]),
    close: () => clearTimeout(timeout),
  };
}

function normalizeFetchError(
  error: unknown,
  operation: string,
  signal: AbortSignal,
  deadline: Deadline,
): Error {
  if (deadline.timeoutError !== undefined
    && signal.aborted
    && signal.reason === deadline.timeoutError) {
    return deadline.timeoutError;
  }

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
  operation: string,
  deadline: Deadline,
): unknown {
  if (!deadline.signal.aborted) return error;

  if (deadline.timeoutError !== undefined
    && deadline.signal.reason === deadline.timeoutError) {
    return deadline.timeoutError;
  }

  if (error instanceof OutboundHttpTimeoutError
    || error instanceof OutboundHttpAbortedError) {
    return error;
  }

  return new OutboundHttpAbortedError(operation, {
    cause: deadline.signal.reason,
  });
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

async function readErrorBody(response: Response): Promise<unknown> {
  const { bytes, truncated } = await readBoundedBody(
    response,
    maximumErrorBodyBytes,
  );
  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = text;

  if (!truncated && text !== "" && (
    contentType.includes("application/json")
    || contentType.includes("+json")
  )) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  return truncated ? { truncated: true, text } : body;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) {
    return { bytes: new Uint8Array(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  while (true) {
    const result = await reader.read();

    if (result.done) break;

    const remaining = maximumBytes - size;

    if (result.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(result.value.slice(0, remaining));
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(result.value);
    size += result.value.byteLength;
  }

  const bytes = new Uint8Array(chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  ));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, truncated };
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
