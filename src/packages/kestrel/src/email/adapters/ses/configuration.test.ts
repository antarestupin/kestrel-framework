import { expect, it } from "vitest";
import { sesEmailConfigBase } from "./configuration.js";
it("requires credentials for SES", () => {
  expect(() => sesEmailConfigBase.schema.parse({ region: "eu-west-1" })).toThrow();
});
