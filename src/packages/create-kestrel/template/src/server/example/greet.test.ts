// Tests the greeting HTTP contract and generated client through Fastify injection.
// Use this pattern for endpoint tests without network listeners and dispose the owned application.

import { afterAll, expect, it } from "vitest";
import { createPublicClient } from "../../generated/publicClient/publicClient.js";
import { httpRuntimeDependency } from "@kestreljs/framework/http";
import app from "../core/app.js";

// This suite owns the composed application; the test configuration disables browser delivery.
const runtime = app.container.resolve(httpRuntimeDependency);
afterAll(async () => {
  try {
    await runtime.stop();
  } finally {
    await app.dispose();
  }
});

it("serves and validates the example operation without a network listener", async () => {
  const response = await runtime.server.inject({ method: "GET", url: "/api/greet?name=Sam" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ message: "Hello, Sam!" });
  expect((await runtime.server.inject({ method: "GET", url: "/api/greet" })).statusCode).toBe(400);
});

it("calls the example through the generated client without a network listener", async () => {
  const client = createPublicClient({
    baseUrl: "http://application.test",
    // Route generated fetch requests through Fastify injection to exercise the real contract.
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const response = await runtime.server.inject({ method: "GET", url: url.pathname + url.search });
      expect(request.method).toBe("GET");
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  });
  // Query encoding must preserve spaces, ampersands, and Unicode in the generated bindings.
  await expect(client.example.greet({ name: "Sam & Zoë" })).resolves.toEqual({ message: "Hello, Sam & Zoë!" });
});
