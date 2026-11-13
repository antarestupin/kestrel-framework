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

  it.each([
    ["app.example:443", 200],
    ["app.example:80", 421],
    ["alternate.example:80", 200],
    ["alternate.example", 421],
    ["app.example/", 421],
    ["app.example/path/..", 421],
    ["app.example\\", 421],
    ["app.example?", 421],
    ["app.example#", 421],
    ["user@app.example", 421],
    ["app%2eexample", 421],
  ] as const)("validates authority %s against HTTPS public origins", async (host, status) => {
    const server = createHardenedServer({
      publicOrigins: ["https://app.example", "https://alternate.example:80"],
    });
    server.get("/", () => "ok");

    // HTTP on the local listener must still normalize the authority as public HTTPS.
    expect((await server.inject({ url: "/", headers: { host } })).statusCode).toBe(status);
  });

  it("applies the complete security response policy to accepted and rejected hosts", async () => {
    const server = createHardenedServer();
    server.get("/", () => "ok");
    for (const [host, status] of [["app.example", 200], ["other.example", 421]] as const) {
      const response = await server.inject({ url: "/", headers: { host } });
      expect(response.statusCode).toBe(status);
      expect(response.headers).toMatchObject({
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "origin-agent-cluster": "?1",
        "referrer-policy": "no-referrer",
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-dns-prefetch-control": "off",
        "x-download-options": "noopen",
        "x-frame-options": "DENY",
        "x-permitted-cross-domain-policies": "none",
        "x-xss-protection": "0",
      });
      expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
      const policy = String(response.headers["content-security-policy"] ?? "");
      const directives = Object.fromEntries(policy.split(";").map((entry) => {
        const [name, ...values] = entry.trim().split(/\s+/u);
        return [name, values];
      }));
      expect(directives).toEqual({
        "base-uri": ["'none'"],
        "connect-src": ["'self'"],
        "default-src": ["'none'"],
        "font-src": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "img-src": ["'self'", "data:"],
        "manifest-src": ["'self'"],
        "object-src": ["'none'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "upgrade-insecure-requests": [],
      });
    }
  });

  it("ignores forwarded authority in direct mode and sets explicit poisoning and shutdown policy", async () => {
    const profile = createHttpHardeningProfile(parseConfig());
    expect(profile.server).toMatchObject({
      onConstructorPoisoning: "error",
      onProtoPoisoning: "error",
      return503OnClosing: true,
      trustProxy: false,
    });
    const server = createHardenedServer();
    server.get("/", (request) => ({ host: request.host, protocol: request.protocol, ip: request.ip }));
    const response = await server.inject({
      url: "/", remoteAddress: "192.0.2.1",
      headers: {
        host: "app.example",
        "x-forwarded-host": "wrong.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.1",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ host: "app.example", protocol: "http", ip: "192.0.2.1" });
  });

  it("retains the configured HSTS policy for a rejected malformed host", async () => {
    const server = createHardenedServer({
      hsts: { maxAgeSeconds: 3_600, includeSubDomains: true, preload: true },
    });
    server.get("/", () => "ok");

    // A malformed authority must stay in the 421 path rather than throw during parsing.
    const response = await server.inject({ url: "/", headers: { host: "[malformed" } });
    expect(response.statusCode).toBe(421);
    expect(response.headers["strict-transport-security"]).toBe("max-age=3600; includeSubDomains; preload");
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
