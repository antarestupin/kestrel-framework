import { describe, expect, it } from "vitest";

import { clearAuthenticationCookie, createAuthenticationCookie, readAuthenticationCookie } from "./cookie.js";

const local = { name: "session", path: "/", secure: false, sameSite: "lax" } as const;
const secure = { name: "__Host-session", path: "/", secure: true, sameSite: "strict" } as const;

describe("authentication cookies", () => {
  it("reads a named cookie only when exactly one non-empty value can be decoded", () => {
    expect(readAuthenticationCookie("other=ignored; session=opaque%3Dvalue ; unrelated=x", "session"))
      .toBe("opaque=value");
    for (const header of [undefined, "other=value", "session=", "session=%zz", "session=one; session=two"]) {
      expect(readAuthenticationCookie(header, "session")).toBeUndefined();
    }
  });

  it("creates and clears the same host-only cookie with explicit security attributes", () => {
    expect(createAuthenticationCookie("token=value", local))
      .toBe("session=token%3Dvalue; Path=/; HttpOnly; SameSite=Lax");
    expect(clearAuthenticationCookie(local))
      .toBe("session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(createAuthenticationCookie("token", secure))
      .toBe("__Host-session=token; Path=/; HttpOnly; Secure; SameSite=Strict");
    expect(clearAuthenticationCookie(secure))
      .toBe("__Host-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  });
});
