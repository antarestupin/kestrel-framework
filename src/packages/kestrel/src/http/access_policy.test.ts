import { expect, it, vi } from "vitest";

it("loads a valid anonymous policy and rejects a blank explicit name", async () => {
  // Import inside the test so a malformed default policy fails the assertion run.
  vi.resetModules();
  const { anonymousHttpAccess, defineHttpAccessPolicy, validateHttpAccessPolicy } = await import("./access.js");

  expect(anonymousHttpAccess).toEqual({ name: "kestrel.http.anonymous", middleware: [] });
  expect(defineHttpAccessPolicy("example.explicit")).toEqual({ name: "example.explicit", middleware: [] });
  expect(() => defineHttpAccessPolicy("  ")).toThrow("An HTTP access policy name cannot be empty.");
  expect(validateHttpAccessPolicy(anonymousHttpAccess)).toBe(anonymousHttpAccess);
  const callable = Object.assign(function invalidPolicy() {}, { middleware: [] });
  for (const policy of [null, callable, { name: "  ", middleware: [] }, { name: "valid", middleware: null }, { name: 42, middleware: [] }]) {
    expect(() => validateHttpAccessPolicy(policy as never)).toThrow("An HTTP controller requires a valid access policy.");
  }
});
