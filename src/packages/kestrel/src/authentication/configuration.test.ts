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
