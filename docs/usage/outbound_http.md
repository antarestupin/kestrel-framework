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
  middleware: [retryRequests()],
});
async function forecast(city: string) {
  return weather.get("/forecast/:city", {
    // Bound the complete logical request, including middleware waits and retries.
    timeoutMs: 5_000,
    path: { city },
    query: { units: "metric" },
    // Validate the decoded body before it reaches the calling service.
    response: json(z.object({ temperature: z.number() })),
  });
}
```

Path values are encoded and query arrays become repeated parameters. Use `post(path, { json: payload, response: json(schema) })` for JSON requests. `text`, `bytes` and `nativeResponse` select other decoders. Structured methods throw `OutboundHttpResponseError` for unsuccessful responses; low-level `fetch` retains native response semantics.

## Share application instrumentation

Use the injected client factory when outgoing requests should appear in the current execution diagnostics. Services still choose their own API client settings.

```ts
import { App } from "@kestreljs/framework/app";
import { OutboundHttpProvider, outboundHttpClientFactoryDependency } from "@kestreljs/framework/outbound_http";

const app = new App({}).register(new OutboundHttpProvider());
// Declare this dependency on the service that creates its dedicated API client.
const dependencies = { clients: outboundHttpClientFactoryDependency };
```

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

Include every value affecting the response in the cache key, including any account-specific context. Only successful responses are cached. Tags require a `TagAwareCache`.

`throttleRequests` integrates [throttling](./throttling.md) per attempt. Middleware orders cache before retry before throttling, so cache hits avoid both admission and network work. The total timeout includes waits and retries. Unsafe methods are not retried by default; enabling retries requires an application idempotency policy. Inject `fetch` in tests to avoid network calls.

## Use cases still to document

- Send JSON bodies with per-request headers and select response decoders.
- Compose throttling with retries so each network attempt acquires admission.
- Cache multiple response types with scoped keys and tag invalidation.
- Handle timeouts, cancellation and typed request failures.
