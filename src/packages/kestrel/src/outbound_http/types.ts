import type { ZodType } from "zod";

import type { OutboundHttpInstrumentation } from "./observations.js";

/** Native inputs accepted by the low-level outbound fetch surface. */
export type OutboundHttpInput = RequestInfo | URL;

/** Headers resolved immediately before each logical outbound request. */
export type OutboundHttpHeaders = HeadersInit | (() =>
  HeadersInit | Promise<HeadersInit>);

/** Conventional ordering leaves space for application middleware. */
export const outboundHttpMiddlewarePriorities = Object.freeze({
  cache: 100,
  retry: 200,
  default: 500,
  throttling: 800,
} as const);

export interface OutboundHttpMiddlewareContext {
  readonly client: string;
  readonly operation: string;
  readonly route: string;
  readonly request: Request;
  /** One-based attempt identity supplied by retrying middleware. */
  readonly attempt: number;
  /** Effective response budget shared by middleware and decoders. */
  readonly maxResponseBytes: number;
}

export interface OutboundHttpNextOptions {
  readonly request?: Request;
  readonly attempt?: number;
}

/** Replays the remaining HTTP middleware with optional request metadata. */
export type OutboundHttpNext = (
  options?: OutboundHttpNextOptions,
) => Promise<Response>;

export interface OutboundHttpMiddleware {
  readonly name: string;
  readonly priority: number;
  handler(
    context: OutboundHttpMiddlewareContext,
    next: OutboundHttpNext,
  ): Promise<Response>;
}

export interface DefineOutboundHttpMiddlewareOptions {
  readonly priority?: number;
  readonly handler: OutboundHttpMiddleware["handler"];
}

/** Byte budgets shared by client defaults and individual calls. */
export interface OutboundHttpResponseLimits {
  /** Maximum consumed response bytes; defaults to 8 MiB. */
  readonly maxResponseBytes?: number;
  /** Maximum retained HTTP error bytes; defaults to 64 KiB. */
  readonly maxErrorBodyBytes?: number;
}

/** Fetch options understood by the outbound execution layer. */
export interface OutboundHttpFetchOptions extends RequestInit, OutboundHttpResponseLimits {
  readonly middleware?: readonly OutboundHttpMiddleware[];
  readonly operation?: string;
  /** Stable route template used by observations instead of the concrete URL. */
  readonly route?: string;
  /** Deadline through response handoff, including middleware and retries. */
  readonly timeoutMs?: number;
}

export interface OutboundHttpClientOptions extends OutboundHttpResponseLimits {
  /** Default logical deadline; calls may override it. */
  readonly timeoutMs?: number;
  readonly name: string;
  readonly baseUrl?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: OutboundHttpHeaders;
  readonly middleware?: readonly OutboundHttpMiddleware[];
  readonly instrumentation?: OutboundHttpInstrumentation;
  readonly monotonicNow?: () => number;
}

/** Fetch-compatible callable enriched with outbound request options. */
export type OutboundHttpFetch = (
  input: OutboundHttpInput,
  options?: OutboundHttpFetchOptions,
) => Promise<Response>;

export type OutboundHttpPathParameters = Readonly<Record<
  string,
  boolean | Date | number | string
>>;

export type OutboundHttpQueryValue =
  | boolean
  | Date
  | number
  | string
  | null
  | undefined;

export type OutboundHttpQuery = Readonly<Record<
  string,
  OutboundHttpQueryValue | readonly OutboundHttpQueryValue[]
>>;

export interface OutboundHttpDecodeContext {
  /** Cooperatively cancel asynchronous validation and application decoding. */
  readonly signal: AbortSignal;
}

export interface OutboundHttpResponseDecoder<Output> {
  /** Explicitly transfers an unread body to the caller after decoding. */
  readonly lifetime?: "stream";
  readonly description: string;
  decode(response: Response, context: OutboundHttpDecodeContext): Promise<Output>;
}

export interface OutboundHttpRequestOptions<Output = Response>
  extends Omit<RequestInit, "body" | "method">, OutboundHttpResponseLimits {
  readonly operation?: string;
  readonly path?: OutboundHttpPathParameters;
  readonly query?: OutboundHttpQuery;
  readonly middleware?: readonly OutboundHttpMiddleware[];
  readonly response?: OutboundHttpResponseDecoder<Output>;
  /** Deadline through decoding, or response handoff for streaming calls. */
  readonly timeoutMs?: number;
}

export interface OutboundHttpBodyRequestOptions<Output = Response>
  extends OutboundHttpRequestOptions<Output> {
  readonly body?: BodyInit | null;
  /** Serializes one JSON body and supplies its content type when absent. */
  readonly json?: unknown;
}

export interface OutboundHttpRequestDefinition<Output = Response>
  extends OutboundHttpBodyRequestOptions<Output> {
  readonly method: string;
  readonly pathTemplate: string;
}

/** Factory registered by the Kestrel provider for automatic observations. */
export interface OutboundHttpClientFactory {
  create(options: OutboundHttpClientOptions): import("./client.js").OutboundHttpClient;
}

/** Runtime JSON decoder accepted by the convenience helper. */
export type OutboundHttpJsonSchema<Output> = ZodType<Output>;
