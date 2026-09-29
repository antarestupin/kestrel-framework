import Fastify, { type FastifyInstance } from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { httpHardeningConfigBase } from "./configuration.js";
import { createHttpHardeningProfile } from "./profile.js";

const servers = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

describe("HTTP hardening profile", () => {
  it("installs bounded transport settings and security response headers", async () => {
    const server = createHardenedServer();

    server.get("/", async () => ({ status: "ok" }));
    const response = await server.inject({
      headers: { host: "app.example" },
      path: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(server.initialConfig).toMatchObject({
      bodyLimit: 256 * 1_024,
      connectionTimeout: 30_000,
      handlerTimeout: 30_000,
      keepAliveTimeout: 65_000,
    });
    expect(server.server.headersTimeout).toBe(10_000);
    expect(server.server.keepAliveTimeoutBuffer).toBe(1_000);
    expect(server.server.maxHeadersCount).toBe(100);
    expect(response.headers["content-security-policy"])
      .toContain("script-src 'self'");
    expect(response.headers["content-security-policy"])
      .not.toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers["strict-transport-security"])
      .toBe("max-age=31536000");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["permissions-policy"])
      .toBe("camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  });

  it("rejects hosts outside the configured public origins", async () => {
    const server = createHardenedServer();

    server.get("/", async () => ({ status: "ok" }));
    const response = await server.inject({
      headers: { host: "attacker.example" },
      path: "/",
    });

    expect(response.statusCode).toBe(421);
    expect(response.json()).toEqual({
      error: "Misdirected Request",
      message: "The request host is not accepted by this server.",
      statusCode: 421,
    });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("trusts forwarding metadata only from the configured proxy CIDRs", async () => {
    const server = createHardenedServer({
      proxy: { mode: "trusted", cidrs: ["127.0.0.1/32"] },
    });

    server.get("/metadata", async (request) => ({
      host: request.host,
      ip: request.ip,
      protocol: request.protocol,
    }));
    const trusted = await server.inject({
      headers: {
        host: "internal.example",
        "x-forwarded-for": "203.0.113.8",
        "x-forwarded-host": "app.example",
        "x-forwarded-proto": "https",
      },
      path: "/metadata",
      remoteAddress: "127.0.0.1",
    });
    const untrusted = await server.inject({
      headers: {
        host: "app.example",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
      path: "/metadata",
      remoteAddress: "192.0.2.10",
    });

    expect(trusted.json()).toEqual({
      host: "app.example",
      ip: "203.0.113.8",
      protocol: "https",
    });
    expect(untrusted.json()).toEqual({
      host: "app.example",
      ip: "192.0.2.10",
      protocol: "http",
    });
  });

  it("enforces the global body limit while allowing explicit route limits", async () => {
    const server = createHardenedServer({
      limits: {
        bodyBytes: 32,
        maxHeadersCount: 100,
        maxRequestsPerSocket: 1_000,
      },
    });

    server.post("/global", async (request) => request.body);
    server.post(
      "/larger",
      { bodyLimit: 128 },
      async (request) => request.body,
    );
    const payload = { value: "a".repeat(48) };

    expect((await server.inject({
      headers: { host: "app.example" },
      method: "POST",
      path: "/global",
      payload,
    })).statusCode).toBe(413);
    expect((await server.inject({
      headers: { host: "app.example" },
      method: "POST",
      path: "/larger",
      payload,
    })).statusCode).toBe(200);
  });

  it("validates HTTPS origins, proxy CIDRs, and timeout ordering", () => {
    expect(() => parseConfig({
      publicOrigins: ["http://app.example"],
    })).toThrow("requires HTTPS public origins");
    expect(() => parseConfig({
      proxy: { mode: "trusted", cidrs: ["not-a-cidr"] },
    })).toThrow("IP address or CIDR");
    expect(() => parseConfig({
      timeouts: {
        connectionMs: 30_000,
        headersMs: 31_000,
        requestMs: 30_000,
        handlerMs: 30_000,
        keepAliveMs: 65_000,
        keepAliveBufferMs: 1_000,
      },
    })).toThrow("header timeout cannot exceed");
  });

  it("refuses to build a disabled profile", () => {
    const config = httpHardeningConfigBase.schema.parse({
      enabled: false,
      publicOrigins: ["http://localhost:3333"],
      proxy: { mode: "direct" },
    });

    expect(() => createHttpHardeningProfile(config)).toThrow(
      "must be enabled before use",
    );
  });
});

function createHardenedServer(
  overrides: Record<string, unknown> = {},
): FastifyInstance {
  const config = parseConfig(overrides);
  const profile = createHttpHardeningProfile(config);
  const server = Fastify(profile.server);

  servers.add(server);
  profile.install(server);
  return server;
}

function parseConfig(overrides: Record<string, unknown> = {}) {
  return httpHardeningConfigBase.schema.parse({
    enabled: true,
    publicOrigins: ["https://app.example"],
    proxy: { mode: "direct" },
    ...overrides,
  });
}
