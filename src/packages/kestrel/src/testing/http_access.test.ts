import { expect, it } from "vitest";

it("provides an explicitly unrestricted HTTP test policy with a stable name", async () => {
  // Load the fixture within the assertion so an invalid declaration is a test failure.
  const { testHttpAccess } = await import("./http_access.js");
  expect(testHttpAccess).toEqual({ name: "test.http.unrestricted", middleware: [] });
});
