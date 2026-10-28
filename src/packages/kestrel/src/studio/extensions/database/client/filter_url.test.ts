import { expect, it } from "vitest";
import { databaseFilterUrl } from "./filter_url.js";

it("round-trips the selected filter without losing mount paths, unrelated search or fragments", () => {
  const original = "/tools/studio/database?other=hello%20world#schema";
  const enabled = databaseFilterUrl(original, true);
  const url = new URL(enabled, "http://studio.invalid");
  expect(url.pathname).toBe("/tools/studio/database");
  expect(url.searchParams.get("other")).toBe("hello world");
  expect(url.searchParams.get("hideFramework")).toBe("true");
  expect(url.hash).toBe("#schema");
  const disabled = new URL(databaseFilterUrl(enabled, false), url.origin);
  expect(disabled.searchParams.has("hideFramework")).toBe(false);
  expect(disabled.searchParams.get("other")).toBe("hello world");
  expect(disabled.hash).toBe("#schema");
  expect(databaseFilterUrl(enabled, true)).toBe(enabled);
});
