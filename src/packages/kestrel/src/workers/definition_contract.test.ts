import { describe, expect, it } from "vitest";
import { z } from "zod";

import { dep } from "../di/index.js";
import { defineRateLimit, seconds } from "../throttling/index.js";
import { defineWorker, jobFail, jobSuccess } from "./worker.js";

const input = z.string();
const handler = () => undefined;
const base = { name: "contract", queue: "contract-queue", input, handler };
const admission = defineRateLimit({ id: "worker-contract-rate", requests: 1, per: seconds(1) });
const requirements = () => ({ admission });

describe("worker definition contracts", () => {
  it("retains declared metadata and applies individual execution defaults", () => {
    const dependency = dep<string>("worker-dependency");
    const examples = [{ name: "example", payload: "input" }];
    const worker = defineWorker({ ...base, description: "public worker", examples, dependencies: { dependency }, validation: { input: "async" } });
    expect(worker).toMatchObject({ name: base.name, queue: base.queue, description: "public worker", inputSchema: input, examples, dependencies: { dependency }, validation: { input: "async", output: "sync" }, weight: 1, maxAttempts: 3, retryDelayMs: 1_000, maxRetryDelayMs: 60_000, batch: false, handler });
    const defaults = defineWorker(base);
    expect(defaults.dependencies).toEqual({});
    expect(Object.hasOwn(defaults, "description")).toBe(false);
    expect(Object.hasOwn(defaults, "examples")).toBe(false);
    expect(defineWorker({ ...base, batch: false }).batch).toBe(false);
  });

  it("retains explicit tuning and both batch overflow policies", () => {
    const worker = defineWorker({ ...base, weight: 2.5, maxAttempts: 7, retryDelayMs: 0.5, maxRetryDelayMs: 1.5, batch: { size: 4, allowOverflow: false } });
    expect(worker).toMatchObject({ weight: 2.5, maxAttempts: 7, retryDelayMs: 0.5, maxRetryDelayMs: 1.5, batch: { size: 4, allowOverflow: false } });
    expect(defineWorker({ ...base, batch: { size: 2 } }).batch).toEqual({ size: 2, allowOverflow: true });
    expect(defineWorker({ ...base, batch: { size: 3, allowOverflow: true } }).batch).toEqual({ size: 3, allowOverflow: true });
  });

  it.each(["name", "queue"] as const)("rejects an empty %s", (key) => {
    expect(() => defineWorker({ ...base, [key]: "" })).toThrow(
      key === "name" ? "Worker names cannot be empty." : "Worker queue names cannot be empty.",
    );
  });

  it.each(["weight", "retryDelayMs", "maxRetryDelayMs"] as const)("rejects invalid positive %s values", (key) => {
    for (const value of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => defineWorker({ ...base, [key]: value })).toThrow(`${key} must be a positive finite number.`);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid maximum attempts %s", (maxAttempts) => {
    expect(() => defineWorker({ ...base, maxAttempts })).toThrow("maxAttempts must be a positive integer.");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid batch size %s", (size) => {
    expect(() => defineWorker({ ...base, batch: { size } })).toThrow("Worker batch size must be a positive integer.");
  });

  it("retains the release strategy and explicit defer/hold tuning", () => {
    const buffering = { strategy: "release" } as const;
    expect(defineWorker({ ...base, throttling: { requirements, buffering } }).throttling).toEqual({ requirements, buffering });
    expect(defineWorker({ ...base, throttling: { requirements, buffering: { strategy: "defer", fallbackDelayMs: 12 } } }).throttling).toEqual({ requirements, buffering: { strategy: "defer", fallbackDelayMs: 12 } });
    expect(defineWorker({ ...base, throttling: { requirements, buffering: { strategy: "hold", maxHoldMs: 13, fallbackDelayMs: 14 } } }).throttling).toStrictEqual({ requirements, buffering: { strategy: "hold", maxHoldMs: 13, fallbackDelayMs: 14 } });
  });

  it.each([0, -1, NaN, Infinity])("rejects non-positive or non-finite buffering tuning %s", (value) => {
    for (const buffering of [{ strategy: "defer", fallbackDelayMs: value }, { strategy: "hold", maxHoldMs: value }] as const) {
      expect(() => defineWorker({ ...base, throttling: { requirements, buffering } })).toThrow(TypeError);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid held-job limits %s", (maxBlockedJobs) => {
    expect(() => defineWorker({ ...base, throttling: { requirements, buffering: { strategy: "hold", maxBlockedJobs } } })).toThrow(TypeError);
  });

  it("rejects a malformed requirements callback at the untyped boundary", () => {
    expect(() => defineWorker({ ...base, throttling: { requirements: undefined as never } }))
      .toThrow("Worker throttling requirements must be a function.");
  });

  it("creates successful and failed job outcomes without losing caller data", () => {
    const result = { value: 1 };
    expect(jobSuccess("job", result)).toEqual({ key: "job", status: "success", result });
    const cause = new Error("failed job");
    const failure = { cause, retryDelayMs: 0, maxAttempts: 1 };
    expect(jobFail("job", failure)).toEqual({ key: "job", status: "error", error: failure });
    expect(jobFail("default", { cause })).toEqual({ key: "default", status: "error", error: { cause } });
  });

  it.each([-1, NaN, Infinity])("rejects invalid per-job retry delays %s", (retryDelayMs) => {
    expect(() => jobFail("job", { cause: "failure", retryDelayMs })).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid per-job attempt limits %s", (maxAttempts) => {
    expect(() => jobFail("job", { cause: "failure", maxAttempts })).toThrow("Worker batch maxAttempts must be a positive integer.");
  });
});
