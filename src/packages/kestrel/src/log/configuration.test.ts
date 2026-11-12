import { expect, it } from "vitest";

import { loggerConfigBase } from "./configuration.js";

it("uses the same logger defaults for an omitted or empty execution policy", () => {
  const expected = {
    level: "info", developmentStorage: false,
    executionLog: { enabled: true, contextMode: "completion" },
  };
  expect(loggerConfigBase.schema.parse({})).toStrictEqual(expected);
  expect(loggerConfigBase.schema.parse({ executionLog: {} })).toStrictEqual(expected);
  expect(loggerConfigBase.schema.parse({ executionLog: { contextMode: "completion" } })).toStrictEqual(expected);
});

it.each([false, "false", "off"])("interprets execution-log setting %s as disabled", (enabled) => {
  expect(loggerConfigBase.schema.parse({
    level: "warn", developmentStorage: true, executionLog: { enabled, contextMode: "dynamic" },
  })).toStrictEqual({
    level: "warn", developmentStorage: true, executionLog: { enabled: false, contextMode: "dynamic" },
  });
});

it.each([
  { level: "" },
  { developmentStorage: "true" },
  { executionLog: { enabled: 1 } },
  { executionLog: { contextMode: "always" } },
])("rejects unsupported logger configuration %j", (input) => {
  expect(loggerConfigBase.schema.safeParse(input).success).toBe(false);
});
