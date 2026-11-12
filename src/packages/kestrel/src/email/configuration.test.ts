import { expect, it } from "vitest";
import { emailConfigBase } from "./configuration.js";
it("keeps shared email configuration independent from backend selection", () => {
  expect(emailConfigBase.schema.parse({})).toEqual({ enabled: false, name: "transactional" });
});

it.each([".mailer", "mailer invalid", "a".repeat(129)])("rejects non-stable client name %s", (name) => {
  expect(emailConfigBase.schema.safeParse({ name }).success).toBe(false);
});
