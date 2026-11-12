import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emailConfigBase } from "../../configuration.js";
import { smtpEmail } from "./definition.js";
import { smtpEmailConfigBase } from "./configuration.js";

beforeEach(() => { vi.stubEnv("EMAIL_SDK_TELEMETRY", "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

it("validates SMTP settings and applies secure defaults", () => {
  expect(smtpEmailConfigBase.schema.parse({ host: "smtp.example.test" })).toMatchObject({
    secure: false,
    requireTLS: true,
    allowInsecureAuth: false,
    timeoutMs: 15000,
  });
  expect(() => smtpEmailConfigBase.schema.parse({ host: "smtp.example.test", port: -1 })).toThrow();
});

it("keeps explicit credentials and the PLAIN authentication method", () => {
  const auth = { user: "test-user", pass: "test-pass", method: "plain" as const };
  expect(smtpEmailConfigBase.schema.parse({ host: "smtp.example.test", auth }).auth).toEqual(auth);
  expect(smtpEmailConfigBase.schema.safeParse({ host: "smtp.example.test", auth: { user: "test-user" } }).success).toBe(false);
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
