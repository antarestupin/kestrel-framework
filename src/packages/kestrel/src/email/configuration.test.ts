import { expect, it } from "vitest";
import { emailConfigBase } from "./configuration.js";
it("keeps shared email configuration independent from backend selection", () => {
  expect(emailConfigBase.schema.parse({})).toEqual({ enabled: false, name: "transactional" });
});
