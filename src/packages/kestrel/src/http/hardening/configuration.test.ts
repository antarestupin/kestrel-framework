import { describe, expect, it, vi } from "vitest";

describe("HTTP hardening configuration", () => {
  it("validates HTTPS origins, proxy CIDRs, and timeout ordering", async () => {
    const schema = await loadSchema();
    expect(() => parseConfig(schema, {
      publicOrigins: ["http://app.example"],
    })).toThrow("requires HTTPS public origins");
    expect(() => parseConfig(schema, {
      proxy: { mode: "trusted", cidrs: ["not-a-cidr"] },
    })).toThrow("IP address or CIDR");
    expect(() => parseConfig(schema, { proxy: { mode: "trusted", cidrs: ["::1/128/1"] } })).toThrow("IP address or CIDR");
    expect(parseConfig(schema, { proxy: { mode: "trusted", cidrs: ["::1/128"] } }).proxy)
      .toEqual({ mode: "trusted", cidrs: ["::1/128"] });
    expect(() => parseConfig(schema, {
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

  it("enforces proxy family limits and accepts host addresses and zero-length prefixes", async () => {
    const schema = await loadSchema();
    const cidrs = ["192.0.2.1", "192.0.2.0/0", "192.0.2.1/32", "::1", "::/0", "::1/128"];
    expect(parseConfig(schema, { proxy: { mode: "trusted", cidrs } }).proxy).toEqual({ mode: "trusted", cidrs });
    for (const invalid of ["192.0.2.1/33", "::1/129", "hostname/32", "192.0.2.1/-1", "::1/+1", "::1/1a", "::1/0x10", "::1/128/1"]) {
      expect(() => parseConfig(schema, { proxy: { mode: "trusted", cidrs: [invalid] } })).toThrow("IP address or CIDR");
    }
  });

  it("validates canonical public origins and retains nested defaults and timeout boundaries", async () => {
    const schema = await loadSchema();
    const valid = schema.parse({
      publicOrigins: ["https://app.example", "http://local.example"],
      proxy: { mode: "direct" }, timeouts: { headersMs: 30_000 }, limits: {}, hsts: {},
    });
    expect(valid.enabled).toBe(false);
    expect(valid.timeouts.headersMs).toBe(valid.timeouts.requestMs);
    expect(valid.limits.bodyBytes).toBe(256 * 1_024);
    expect(valid.hsts).toEqual({ maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false });
    // Configuration diagnostics identify the field an application needs to change.
    const invalidOrigin = schema.safeParse({ ...valid, enabled: true });
    expect(invalidOrigin.error?.issues).toMatchObject([{
      code: "custom", path: ["publicOrigins"], message: expect.stringContaining("requires HTTPS public origins"),
    }]);
    const invalidTimeout = schema.safeParse({
      ...valid, timeouts: { ...valid.timeouts, headersMs: valid.timeouts.requestMs + 1 },
    });
    expect(invalidTimeout.error?.issues).toMatchObject([{
      code: "custom", path: ["timeouts", "headersMs"], message: expect.stringContaining("header timeout cannot exceed"),
    }]);
    for (const origin of ["ftp://app.example", "https://app.example/path", "https://user@app.example", "https://app.example:443"]) {
      expect(() => parseConfig(schema, { publicOrigins: [origin] })).toThrow("scheme, host, and optional port");
    }
  });

  it("supplies complete defaults when all three option groups are omitted", async () => {
    const schema = await loadSchema();
    expect(parseConfig(schema, {})).toMatchObject({
      timeouts: { connectionMs: 30_000, headersMs: 10_000, requestMs: 30_000, handlerMs: 30_000, keepAliveMs: 65_000, keepAliveBufferMs: 1_000 },
      limits: { bodyBytes: 256 * 1_024, maxHeadersCount: 100, maxRequestsPerSocket: 1_000 },
      hsts: { maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false },
    });
  });
});

async function loadSchema() {
  // Zod can reject invalid discriminants at import time under Stryker.
  vi.resetModules();
  return (await import("./configuration.js")).httpHardeningConfigBase.schema;
}

function parseConfig(schema: Awaited<ReturnType<typeof loadSchema>>, overrides: Record<string, unknown>) {
  return schema.parse({ enabled: true, publicOrigins: ["https://app.example"], proxy: { mode: "direct" }, ...overrides });
}
