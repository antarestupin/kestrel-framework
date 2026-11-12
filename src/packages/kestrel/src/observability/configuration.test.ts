import { expect, it } from "vitest";

import { observationConfigBase } from "./configuration.js";

const defaults = {
  enabled: false,
  overflowPolicy: "drop-new",
  failurePolicy: "best-effort",
  buffer: { batchSize: 50, flushIntervalMs: 100, maxQueueSize: 10_000 },
  retry: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5_000 },
};

it("applies the same defaults when nested policy objects are omitted or empty", () => {
  expect(observationConfigBase.schema.parse({})).toStrictEqual(defaults);
  expect(observationConfigBase.schema.parse({ buffer: {}, retry: {} })).toStrictEqual(defaults);
  expect(observationConfigBase.schema.parse({ failurePolicy: "best-effort" })).toStrictEqual(defaults);
});

it("coerces numeric settings and accepts zero or equal retry delays", () => {
  const parsed = observationConfigBase.schema.parse({
    enabled: true, overflowPolicy: "drop-new", failurePolicy: "fail-fast",
    buffer: { batchSize: "1", flushIntervalMs: "2", maxQueueSize: 3 },
    retry: { maxAttempts: "1", initialDelayMs: "0", maxDelayMs: 0 },
  });

  expect(parsed).toStrictEqual({
    enabled: true, overflowPolicy: "drop-new", failurePolicy: "fail-fast",
    buffer: { batchSize: 1, flushIntervalMs: 2, maxQueueSize: 3 },
    retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
  });
});

it.each([
  { enabled: "true" },
  { overflowPolicy: "drop-old" },
  { failurePolicy: "ignore" },
  { buffer: { batchSize: 0 } },
  { buffer: { flushIntervalMs: "1.5" } },
  { buffer: { maxQueueSize: true } },
  { retry: { maxAttempts: "never" } },
  { retry: { initialDelayMs: -1 } },
  { retry: { maxDelayMs: "Infinity" } },
])("rejects unsupported observation configuration %j", (input) => {
  expect(observationConfigBase.schema.safeParse(input).success).toBe(false);
});

it("reports which retry bounds conflict when the starting delay exceeds the cap", () => {
  const result = observationConfigBase.schema.safeParse({ retry: { initialDelayMs: 2, maxDelayMs: 1 } });
  expect(result.error?.issues).toContainEqual(expect.objectContaining({
    path: ["retry"], message: "Initial retry delay cannot exceed its maximum delay.",
  }));
});
