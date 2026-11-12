import { expect, it } from "vitest";
import { emailConfigBase } from "../../configuration.js";
import { sesEmail } from "./definition.js";
import { sesEmailConfigBase } from "./configuration.js";
it("requires credentials for SES", () => {
  expect(() => sesEmailConfigBase.schema.parse({ region: "eu-west-1" })).toThrow();
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
