import type { HttpMethod } from "./route.js";

type JsonPrimitive = boolean | null | number | string;

/** Maps a server-side schema output to the value received through JSON. */
export type HttpClientOutput<Value> =
  Value extends Date ? string
    : Value extends undefined ? void
      : Value extends JsonPrimitive ? Value
        : Value extends readonly (infer Item)[]
          ? HttpClientOutput<Item>[]
          : Value extends object
            ? { [Key in keyof Value]: HttpClientOutput<Value[Key]> }
            : Value;

export interface HttpClientOptions {
  /** Absolute or same-origin base URL prepended to generated route paths. */
  readonly baseUrl: string;
  /** Fetch implementation, injectable for server rendering and tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Headers applied to every request, for example authentication metadata. */
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface HttpClientInputBinding {
  readonly field: string;
  readonly kind: "body" | "path" | "query";
  readonly name: string;
}

export interface HttpClientOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly bindings: readonly HttpClientInputBinding[];
}

/** Error raised when the server returns a non-successful HTTP response. */
export class HttpClientError extends Error {
  readonly name = "HttpClientError";

  constructor(
    readonly operationId: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: unknown,
  ) {
    super(`HTTP operation ${operationId} failed with status ${status}.`);
  }
}

export interface HttpClientTransport {
  request<Output>(
    operation: HttpClientOperation,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<Output>;
}

/** Creates the framework-independent transport used by generated clients. */
export function createHttpClientTransport(
  options: HttpClientOptions,
): HttpClientTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  if (fetchImplementation === undefined) {
    throw new TypeError("An HTTP client fetch implementation is required.");
  }

  return {
    async request<Output>(
      operation: HttpClientOperation,
      input: Readonly<Record<string, unknown>> = {},
    ): Promise<Output> {
      const request = buildRequest(operation, input);
      const configuredHeaders = typeof options.headers === "function"
        ? await options.headers()
        : options.headers;
      const headers = new Headers(configuredHeaders);

      if (request.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const response = await fetchImplementation(
        joinUrl(options.baseUrl, request.url),
        {
          method: operation.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        },
      );
      const body = await readResponseBody(response);

      if (!response.ok) {
        throw new HttpClientError(
          operation.operationId,
          response.status,
          response.statusText,
          body,
        );
      }

      return body as Output;
    },
  };
}

function buildRequest(
  operation: HttpClientOperation,
  input: Readonly<Record<string, unknown>>,
): { url: string; body?: string } {
  let url = operation.url;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let hasBody = false;

  for (const binding of operation.bindings) {
    const value = input[binding.field];

    if (binding.kind === "path") {
      if (value === undefined || value === null) {
        throw new TypeError(
          `HTTP path input ${binding.field} is required for ${operation.operationId}.`,
        );
      }

      url = replacePathParameter(url, binding.name, serializeScalar(value));
      continue;
    }

    if (binding.kind === "query") {
      appendQueryValue(query, binding.name, value);
      continue;
    }

    body[binding.name] = value;
    hasBody = true;
  }

  const queryString = query.toString();

  if (queryString !== "") {
    url += `${url.includes("?") ? "&" : "?"}${queryString}`;
  }

  return {
    url,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  };
}

function replacePathParameter(
  url: string,
  name: string,
  value: string,
): string {
  const marker = `:${name}`;
  const markerIndex = url.split("/").findIndex(
    (segment) => segment === marker,
  );

  if (markerIndex < 0) {
    throw new TypeError(
      `HTTP path parameter ${name} does not exist in route ${url}.`,
    );
  }

  const segments = url.split("/");
  segments[markerIndex] = encodeURIComponent(value);

  return segments.join("/");
}

function appendQueryValue(
  query: URLSearchParams,
  name: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      query.append(name, serializeScalar(item));
    }

    return;
  }

  query.append(name, serializeScalar(value));
}

function serializeScalar(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return String(value);
}

function joinUrl(baseUrl: string, routeUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${routeUrl}`;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();

  if (text === "") {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";

  return contentType.includes("application/json")
    || contentType.includes("+json")
    ? JSON.parse(text) as unknown
    : text;
}
