import { describe, expect, it, vi } from "vitest";

import {
  getAtlasLoginReturnTo,
  isAtlasLoginPath,
  signOutAtlas,
  signInAtlasWithPassword,
} from "./login_runtime.js";

const authentication = {
  loginPath: "/atlas/login",
  passwordSignInUrl: "/authentication/password/sign-in",
  signOutUrl: "/authentication/sign-out",
};

describe("atlas login runtime", () => {
  it("recognizes only the configured login document", () => {
    expect(isAtlasLoginPath("/atlas/login", authentication)).toBe(true);
    expect(isAtlasLoginPath("/atlas", authentication)).toBe(false);
    expect(isAtlasLoginPath("/atlas/login/extra", authentication)).toBe(false);
  });

  it("keeps return targets inside Atlas boundary", () => {
    expect(getAtlasLoginReturnTo(
      "?returnTo=%2Fatlas%2Fusers%3Fpage%3D2%23record",
      "/atlas",
      "/atlas/login",
    )).toBe("/atlas/users?page=2#record");

    for (const unsafeTarget of [
      "https://attacker.example/atlas",
      "//attacker.example/atlas",
      "/atlas/../account",
      "/atlas/login",
      "/application",
    ]) {
      expect(getAtlasLoginReturnTo(
        `?returnTo=${encodeURIComponent(unsafeTarget)}`,
        "/atlas",
        "/atlas/login",
      )).toBe("/atlas");
    }
  });

  it("posts credentials to the configured endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    await expect(signInAtlasWithPassword(
      authentication.passwordSignInUrl,
      { username: "operator", password: "operator" },
      request,
    )).resolves.toEqual({ status: "authenticated" });
    expect(request).toHaveBeenCalledWith(
      "/authentication/password/sign-in",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ username: "operator", password: "operator" }),
      }),
    );
  });

  it.each([
    [401, "invalid"],
    [403, "untrusted-origin"],
    [429, "rate-limited"],
    [500, "unavailable"],
  ] as const)("maps status %s to %s", async (status, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status }),
    );

    await expect(signInAtlasWithPassword(
      authentication.passwordSignInUrl,
      { username: "operator", password: "wrong" },
      request,
    )).resolves.toEqual({ status: expected });
  });

  it("maps network failures without exposing transport details", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("connection refused"),
    );

    await expect(signInAtlasWithPassword(
      authentication.passwordSignInUrl,
      { username: "operator", password: "operator" },
      request,
    )).resolves.toEqual({ status: "unavailable" });
  });

  it("signs out through the configured endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(signOutAtlas(
      authentication.signOutUrl,
      request,
    )).resolves.toEqual({ status: "signed-out" });
    expect(request).toHaveBeenCalledWith(
      "/authentication/sign-out",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
  });

  it("keeps the user signed in when sign-out is unavailable", async () => {
    const serverFailure = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    const networkFailure = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("connection refused"),
    );

    await expect(signOutAtlas(
      authentication.signOutUrl,
      serverFailure,
    )).resolves.toEqual({ status: "unavailable" });
    await expect(signOutAtlas(
      authentication.signOutUrl,
      networkFailure,
    )).resolves.toEqual({ status: "unavailable" });
  });
});
