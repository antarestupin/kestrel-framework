import { describe, expect, it } from "vitest";

import { emailConfigBase } from "./configuration.js";

describe("emailConfigBase", () => {
  it("provides a disabled, bounded capture default", () => {
    expect(emailConfigBase.schema.parse({})).toEqual({
      enabled: false,
      name: "transactional",
      driver: { type: "capture" },
      capture: {
        storage: "postgres",
        retentionDays: 7,
        maxMessageBytes: 10 * 1_024 * 1_024,
      },
    });
  });

  it("validates and completes SMTP configuration", () => {
    expect(emailConfigBase.schema.parse({
      enabled: true,
      driver: {
        type: "smtp",
        host: "smtp.example.test",
        auth: { user: "mailer", pass: "secret" },
      },
    })).toMatchObject({
      driver: {
        type: "smtp",
        host: "smtp.example.test",
        secure: false,
        requireTLS: true,
        allowInsecureAuth: false,
        timeoutMs: 15_000,
      },
    });
  });

  it("requires SES credentials when SES is selected", () => {
    expect(() => emailConfigBase.schema.parse({
      enabled: true,
      driver: { type: "ses", region: "eu-west-1" },
    })).toThrow();
  });
});
