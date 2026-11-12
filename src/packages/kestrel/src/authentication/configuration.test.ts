import { describe, expect, it } from "vitest";

import { authenticationConfigBase } from "./configuration.js";

// Exercise the public parser rather than constructing an already typed policy.
function parseCookie(cookie: Record<string, unknown>) {
  return authenticationConfigBase.schema.parse({
    session: {},
    mechanisms: { password: {} },
    http: { cookie, trustedOrigins: ["https://app.example"] },
  }).http.cookie;
}

describe("authentication cookie configuration", () => {
  it("defaults to a secure host cookie with a root path and lax SameSite policy", () => {
    expect(parseCookie({})).toEqual({
      name: "__Host-session", secure: true, sameSite: "lax", path: "/",
    });
  });

  // Defaults alone do not validate the enum's explicitly supplied alternatives.
  it.each(["lax", "strict"])("accepts explicit SameSite policy %s", (sameSite) => {
    expect(parseCookie({ sameSite }).sameSite).toBe(sameSite);
  });

  it.each(["", "none", "unsupported"])("rejects unsupported SameSite policy %j", (sameSite) => {
    expect(() => parseCookie({ sameSite })).toThrow();
  });

  it("accepts an explicit root path and preserves a custom cookie name", () => {
    expect(parseCookie({ name: "custom-session", path: "/" })).toMatchObject({
      name: "custom-session", path: "/",
    });
  });

  it.each(["", "/account"])("rejects a non-root cookie path %j", (path) => {
    expect(() => parseCookie({ path })).toThrow();
  });
});

describe("authentication policy constraints", () => {
  it.each([
    {
      override: { session: { idleTtlSeconds: 600, absoluteTtlSeconds: 599 } },
      path: ["session", "idleTtlSeconds"],
      message: "Session idle TTL cannot exceed its absolute TTL.",
    },
    {
      override: { session: { idleTtlSeconds: 60, touchIntervalSeconds: 61 } },
      path: ["session", "touchIntervalSeconds"],
      message: "Session touch interval cannot exceed its idle TTL.",
    },
    {
      override: { mechanisms: { password: { minLength: 20, maxLength: 19 } } },
      path: ["mechanisms", "password", "minLength"],
      message: "Password minimum length cannot exceed its maximum length.",
    },
    {
      override: { http: { cookie: { secure: false }, trustedOrigins: ["https://app.example"] } },
      path: ["http", "cookie", "secure"],
      message: "__Host- cookies require secure transport.",
    },
  ])("rejects an invalid policy at $path", ({ override, path, message }) => {
    // Valid field types still have to satisfy the cross-field security rules.
    const result = authenticationConfigBase.schema.safeParse({
      session: {},
      mechanisms: { password: {} },
      http: { cookie: {}, trustedOrigins: ["https://app.example"] },
      ...override,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: "custom", path, message })]);
  });

  it("accepts equal expiry and password boundaries and an explicit local cookie", () => {
    const policy = authenticationConfigBase.schema.parse({
      session: { idleTtlSeconds: "60", absoluteTtlSeconds: "60", touchIntervalSeconds: "60" },
      mechanisms: { password: { minLength: 20, maxLength: 20 } },
      http: { cookie: { name: "local-session", secure: false }, trustedOrigins: ["http://app.example"] },
    });

    expect(policy.session).toMatchObject({ idleTtlSeconds: 60, absoluteTtlSeconds: 60, touchIntervalSeconds: 60 });
    expect(policy.mechanisms.password).toEqual({ minLength: 20, maxLength: 20 });
    expect(policy.http.cookie).toMatchObject({ name: "local-session", secure: false });
  });

  it("accepts stronger tokens and more than one trusted client origin", () => {
    const trustedOrigins = ["https://app.example", "https://admin.example"];
    const policy = authenticationConfigBase.schema.parse({
      session: { tokenBytes: "48" },
      mechanisms: { password: {} },
      http: { cookie: {}, trustedOrigins },
    });
    expect(policy.session.tokenBytes).toBe(48);
    expect(policy.http.trustedOrigins).toEqual(trustedOrigins);
  });
});
