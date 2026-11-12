import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emailConfigBase } from "../../configuration.js";
import { sesEmail } from "./definition.js";
import { sesEmailConfigBase } from "./configuration.js";

beforeEach(() => { vi.stubEnv("EMAIL_SDK_TELEMETRY", "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

it("requires credentials for SES", () => {
  expect(() => sesEmailConfigBase.schema.parse({ region: "eu-west-1" })).toThrow();
});

it("defaults to UTF-8 and accepts a nonempty explicit charset", () => {
  const credentials = { accessKeyId: "test-access", secretAccessKey: "test-secret", region: "eu-west-1" };
  expect(sesEmailConfigBase.schema.parse(credentials).charset).toBe("UTF-8");
  expect(sesEmailConfigBase.schema.parse({ ...credentials, charset: "US-ASCII" }).charset).toBe("US-ASCII");
  expect(sesEmailConfigBase.schema.safeParse({ ...credentials, charset: "" }).success).toBe(false);
});

it.each([{}, { sessionToken: "test-session", baseUrl: "https://ses.example.test", configurationSetName: "example" }])(
  "creates a lazy SES transport with validated optional settings %j", (extra) => {
    const settings = sesEmailConfigBase.schema.parse({
      accessKeyId: "test-access", secretAccessKey: "test-secret", region: "eu-west-1", ...extra,
    });
    const definition = sesEmail(settings);
    const adapter = definition.create(() => { throw new Error("SES has no injected infrastructure"); }, emailConfigBase.schema.parse({}));
    expect(adapter.name).toBe("ses");
  },
);
