import { expect, it } from "vitest";
import { emailConfigBase } from "../../configuration.js";
import { smtpEmail } from "./definition.js";
import { smtpEmailConfigBase } from "./configuration.js";
it("validates SMTP settings and applies secure defaults", () => {
  expect(smtpEmailConfigBase.schema.parse({ host: "smtp.example.test" })).toMatchObject({
    requireTLS: true,
    allowInsecureAuth: false,
    timeoutMs: 15000,
  });
  expect(() => smtpEmailConfigBase.schema.parse({ host: "smtp.example.test", port: -1 })).toThrow();
});

it.each([
  {},
  { port: 587, auth: { user: "test", pass: "test" } },
  { port: 465, secure: true, auth: { user: "test", pass: "test", method: "login" }, heloName: "example.test" },
])("creates a lazy SMTP transport without opening a connection %j", (extra) => {
  const settings = smtpEmailConfigBase.schema.parse({ host: "smtp.example.test", ...extra });
  const definition = smtpEmail(settings);
  const adapter = definition.create(() => { throw new Error("SMTP has no injected infrastructure"); }, emailConfigBase.schema.parse({}));
  expect(adapter.name).toBe("smtp");
});
