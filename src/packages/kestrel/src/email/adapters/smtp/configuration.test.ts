import { expect, it } from "vitest";
import { smtpEmailConfigBase } from "./configuration.js";
it("validates SMTP settings and applies secure defaults", () => {
  expect(smtpEmailConfigBase.schema.parse({ host: "smtp.example.test" })).toMatchObject({
    requireTLS: true,
    allowInsecureAuth: false,
    timeoutMs: 15000,
  });
  expect(() => smtpEmailConfigBase.schema.parse({ host: "smtp.example.test", port: -1 })).toThrow();
});
