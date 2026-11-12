import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { emailConfigBase } from "../configuration.js";
import { sesEmailConfigBase } from "./ses/configuration.js";
import { smtpEmailConfigBase } from "./smtp/configuration.js";

const unavailableDependency = () => { throw new Error("Email transports do not require injected infrastructure."); };
const config = emailConfigBase.schema.parse({});
const capabilities = {
  repeatedHeaders: false, idempotency: "none", scheduling: false, personalized: "unsupported",
} as const;

beforeEach(() => { vi.stubEnv("EMAIL_SDK_TELEMETRY", "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

it("explicitly disables SDK telemetry because Kestrel owns email diagnostics", async () => {
  const createEmailClient = vi.fn(() => ({ send: vi.fn() }));
  vi.resetModules();
  vi.doMock("@opencoredev/email-sdk", async (importOriginal) => ({
    ...await importOriginal<typeof import("@opencoredev/email-sdk")>(),
    createEmailClient,
  }));
  try {
    const { EmailSdkEmailAdapter } = await import("./email_sdk/adapter.js");
    const adapter = { name: "controlled", capabilities, send: vi.fn() };
    const driver = new EmailSdkEmailAdapter({ adapter });
    expect(driver.name).toBe("controlled");
    expect(createEmailClient).toHaveBeenCalledExactlyOnceWith({ adapters: [adapter], telemetry: false });
  } finally {
    vi.doUnmock("@opencoredev/email-sdk");
    vi.resetModules();
  }
});

it("defers SES creation and forwards only the configured transport options", async () => {
  const ses = vi.fn(() => ({ name: "ses", capabilities, send: vi.fn() }));
  // Replace the SDK boundary for this test and discard the imported module afterward.
  vi.resetModules();
  vi.doMock("@opencoredev/email-sdk/ses", () => ({ ses }));
  try {
    const { sesEmail } = await import("./ses/definition.js");
    const required = { accessKeyId: "access", secretAccessKey: "secret", region: "eu-west-1", charset: "UTF-8" };
    const configured = {
      ...required, sessionToken: "session", baseUrl: "https://ses.example.test", configurationSetName: "campaign",
    };
    const first = sesEmail(sesEmailConfigBase.schema.parse(required));
    const second = sesEmail(sesEmailConfigBase.schema.parse(configured));
    expect(ses).not.toHaveBeenCalled();
    expect(first.create(unavailableDependency, config).name).toBe("ses");
    expect(second.create(unavailableDependency, config).name).toBe("ses");
    expect(ses.mock.calls).toStrictEqual([[required], [configured]]);
  } finally {
    vi.doUnmock("@opencoredev/email-sdk/ses");
    vi.resetModules();
  }
});

it("defers SMTP creation and forwards the resolved TLS and authentication options", async () => {
  const smtp = vi.fn(() => ({ name: "smtp", capabilities, send: vi.fn() }));
  vi.resetModules();
  vi.doMock("@opencoredev/email-sdk/smtp", () => ({ smtp }));
  try {
    const { smtpEmail } = await import("./smtp/definition.js");
    const defaults = {
      host: "smtp.example.test", secure: false, requireTLS: true, allowInsecureAuth: false, timeoutMs: 15_000,
    };
    const credentials = { user: "mailer", pass: "password" };
    const configured = {
      ...defaults, secure: true, requireTLS: false, allowInsecureAuth: true, timeoutMs: 8_000,
      port: 2465, heloName: "kestrel.example.test", auth: { ...credentials, method: "login" },
    };
    const definitions = [defaults, configured, { ...defaults, auth: credentials }]
      .map((input) => smtpEmail(smtpEmailConfigBase.schema.parse(input)));
    expect(smtp).not.toHaveBeenCalled();
    for (const definition of definitions) {
      expect(definition.create(unavailableDependency, config).name).toBe("smtp");
    }
    expect(smtp.mock.calls).toStrictEqual([[defaults], [configured], [{ ...defaults, auth: credentials }]]);
  } finally {
    vi.doUnmock("@opencoredev/email-sdk/smtp");
    vi.resetModules();
  }
});
