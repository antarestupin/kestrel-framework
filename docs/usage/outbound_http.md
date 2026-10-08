# Outbound HTTP

[Usage index](./README.md) · [Implementation and middleware contracts](../implementation/outbound_http.md)

Use this server-only library for external APIs. For browser calls to your own controllers, use the [generated HTTP client](./client.md#generate-a-typed-http-client).

## Call an API and validate the response

Create a dedicated client when a service calls an external API with a stable base URL. This forecast request bounds the total duration and validates the decoded response.

```ts
import { z } from "zod";
import { createOutboundHttpClient, json, retryRequests } from "@kestreljs/framework/outbound_http";

const weather = createOutboundHttpClient({
  name: "weather",
  baseUrl: "https://weather.example",
  // Defaults apply to every call and may be overridden per operation.
  timeoutMs: 5_000,
  maxResponseBytes: 8 * 1_024 * 1_024,
  middleware: [retryRequests()],
});
async function forecast(city: string) {
  return weather.get("/forecast/:city", {
    path: { city },
    query: { units: "metric" },
    // Validate the decoded body before it reaches the calling service.
    response: json(z.object({ temperature: z.number() })),
  });
}
```

Path values are encoded and query arrays become repeated parameters. Use `post(path, { json: payload, response: json(schema) })` for JSON requests. `text`, `bytes` and `nativeResponse` select other decoders. Structured methods throw `OutboundHttpResponseError` for unsuccessful responses; low-level `fetch` retains native response semantics.

## Bound time, memory and cancellation

`timeoutMs` covers asynchronous header preparation, middleware and cache waits, retry backoff, network attempts, body consumption, decoding and asynchronous schema validation. Configure it on the client or override it per call. There is no implicit timeout when neither supplies one. The same deadline applies across all attempts; incoming chunks do not reset it.

`maxResponseBytes` defaults to 8 MiB and rejects a successful body with `OutboundHttpResponseTooLargeError` as soon as consumption exceeds the limit. The counter measures bytes exposed by fetch (after any transport decompression), rather than trusting `Content-Length`. Both limits apply to custom decoders and cached responses. Limits must be positive safe integers; use a larger explicit limit for APIs returning large payloads.

`maxErrorBodyBytes` defaults to 64 KiB. Structured calls retain at most the smaller of this limit and `maxResponseBytes` for unsuccessful HTTP responses. Their `OutboundHttpResponseError.body` contains parsed JSON or text, or `{ truncated: true, text }` when truncated. Malformed error JSON remains text. A stalled error body still raises `OutboundHttpTimeoutError` when the deadline expires.

Pass the owning operation's `AbortSignal` through `signal` to cancel an outbound call, including calls without a timeout. Cancellation raises `OutboundHttpAbortedError`. Timeout, cancellation and size errors remain distinct from `OutboundHttpDecodeError`, which indicates malformed successful content or failed validation. The factory's automatic observer integration does not automatically supply an execution signal.

```ts
import { text } from "@kestreljs/framework/outbound_http";

// The calling operation owns this signal and its cancellation policy.
async function fetchSummary(signal: AbortSignal) {
  return weather.get("/summary", {
    signal,
    timeoutMs: 2_000,
    maxResponseBytes: 128 * 1_024,
    maxErrorBodyBytes: 4 * 1_024,
    response: text(),
  });
}
```

Kestrel cancels unfinished response streams on failure and releases its readers, timers and listeners. Cancellation is cooperative: synchronous JavaScript cannot be preempted, and custom asynchronous decoders should honor their second argument's `signal`. The caller stops waiting on expiration even if a decoder, injected transport or cache backend ignores cancellation. An already-started cache write may still finish; partial response bodies are never submitted for storage.

## Return a native response or stream

`fetch()`, a structured call without a decoder, and `nativeResponse()` transfer body ownership to the caller. Their timeout ends when the response is returned, including any preceding cache serialization. Byte limits and the supplied signal remain active while the body is consumed. Low-level `fetch()` preserves unsuccessful status codes and rejects oversized bodies during reading; it does not truncate them into structured HTTP errors.

Consume the returned body or call `response.body?.cancel()`. If a reader has been acquired, cancel that reader and release its lock. Use a caller-owned signal for a stream that needs a deadline after handoff. Cloned branches and streams created by custom middleware also require explicit consumption or cancellation. A custom decoder returning a stream must declare `lifetime: "stream"`; other decoders release unread bodies when they finish.

For decoder and middleware ownership details, see the [implementation contract](../implementation/outbound_http.md#deadlines-and-response-ownership).

## Share application instrumentation

Use the injected client factory to apply application-wide budget defaults and attach outgoing requests to the current execution diagnostics. Services still choose their own endpoint and may override individual budgets.

```ts
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { OutboundHttpProvider, outboundHttpConfigBase, outboundHttpClientFactoryDependency } from "@kestreljs/framework/outbound_http";

// Environment selection and environment reads belong to the application.
const configuration = createConfigurationApi({
  environments: ["local", "prod"],
  defaultEnvironment: "local",
  environmentOverrides: { prefix: "APP_CONFIG" },
});
const config = configuration.resolveConfig(configuration.defineConfig({
  outboundHttp: configure(outboundHttpConfigBase, { timeoutMs: 5_000 }),
}), { environment: process.env.ENVIRONMENT, env: process.env });
const app = new App(config).register(new OutboundHttpProvider(config.outboundHttp));
// Declare this dependency on the service that creates its dedicated API client.
const dependencies = { clients: outboundHttpClientFactoryDependency };
```

`outboundHttpConfigBase` validates shared budgets: an optional positive finite `timeoutMs`, an 8 MiB `maxResponseBytes`, and a 64 KiB `maxErrorBodyBytes`. Byte limits must be positive safe integers. Endpoint URLs remain application-owned. The example supports `APP_CONFIG__OUTBOUND_HTTP__TIMEOUT_MS` and the corresponding byte-limit overrides.

Priority is **call → client → provider → library defaults**, independently for each budget. Omitted or undefined values inherit; they do not disable a configured deadline. `new OutboundHttpProvider()` remains valid and imposes no timeout. Standalone `createOutboundHttpClient()` calls do not inherit provider configuration; pass resolved budgets explicitly when needed.

Call `clients.create(options)` inside that service. The provider connects calls to the current execution's observer. It records stable operation names and route templates, not request URLs, headers or bodies. An explicit `operation` can name a business API operation.

## Cache a response

Cache a successful read when repeated calls may reuse a response for a short time. The forecast key separates cities so one location cannot receive another location's cached value.

```ts
import type { Cache } from "@kestreljs/framework/cache";
import { cacheResponse } from "@kestreljs/framework/outbound_http";

function cachedForecast(cache: Cache, city: string) {
  return weather.get("/forecast/:city", {
    path: { city },
    response: json(z.object({ temperature: z.number() })),
    // Separate entries by city and reuse successful responses for one minute.
    middleware: [cacheResponse({ cache, key: `forecast:${city}`, ttlSeconds: 60 })],
  });
}
```

Include every value affecting the response in the cache key, including any account-specific context. Only successful responses are cached. Cache misses are bounded before base64 serialization; hits are checked against the current call's byte limit before decoding base64. A cache backend may have a smaller entry limit, including serialization overhead. Tags require a `TagAwareCache`.

`throttleRequests` integrates [throttling](./throttling.md) per attempt. Middleware orders cache before retry before throttling, so cache hits avoid both admission and network work. The total timeout includes waits and retries. Unsafe methods are not retried by default; enabling retries requires an application idempotency policy. Inject `fetch` in tests to avoid network calls.

## Use cases still to document

- Send JSON bodies with per-request headers and select response decoders.
- Compose throttling with retries so each network attempt acquires admission.
- Cache multiple response types with scoped keys and tag invalidation.
