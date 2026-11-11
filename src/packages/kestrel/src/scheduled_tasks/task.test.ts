import { describe, expect, it, vi } from "vitest";

import { dep } from "../di/index.js";
import { every } from "./schedule.js";
import { createNextRunDeferral, defineScheduledTask, type ScheduledTaskRuntimeOptions } from "./task.js";

const schedule = every({ seconds: 1 });

describe("scheduled task definitions", () => {
  it("supplies defaults while retaining the public handler and schedule", () => {
    const handler = vi.fn();
    expect(defineScheduledTask({ id: "billing.invoice-run_2", schedule, handler })).toStrictEqual({ id: "billing.invoice-run_2", schedule, handler, dependencies: {}, groups: [], runtime: {}, overlap: "skip", executionLog: true, observe: true });
  });

  it("retains explicit options and copies mutable group and runtime inputs", () => {
    const groups = ["billing", "billing", "maintenance"];
    const runtime: ScheduledTaskRuntimeOptions = { state: "memory", coordination: "local" };
    const dependencies = { clock: dep<Date>("clock") };
    const handler = vi.fn();
    const task = defineScheduledTask({ id: "task", description: "Task description", groups, runtime, dependencies, schedule, handler, overlap: "parallel", executionLog: false, observe: false });
    groups.push("later"); runtime.state = "persistent";
    expect(task).toEqual({ id: "task", description: "Task description", groups: ["billing", "maintenance"], runtime: { state: "memory", coordination: "local" }, dependencies, schedule, handler, overlap: "parallel", executionLog: false, observe: false });
    expect(task.dependencies).toBe(dependencies);
    expect(task.runtime).not.toBe(runtime);
  });

  it.each(["", "UPPER", ".leading", "trailing.", "a..b", "a b", "!prefix", "suffix!"])("rejects an invalid id %j during composition", (id) => {
    expect(() => defineScheduledTask({ id, schedule, handler: () => undefined })).toThrow(expect.objectContaining({
      name: "TypeError", message: expect.stringMatching(/\bids\b/u),
    }));
  });

  it("rejects empty groups without rejecting ordinary group labels", () => {
    expect(() => defineScheduledTask({ id: "task", schedule, groups: ["valid", ""], handler: () => undefined })).toThrow(expect.objectContaining({
      name: "TypeError", message: expect.stringMatching(/\bgroups\b/u),
    }));
    expect(defineScheduledTask({ id: "task", schedule, groups: ["valid group"], handler: () => undefined }).groups).toEqual(["valid group"]);
  });
});

describe("next-run deferrals", () => {
  it("isolates invocations and retains the largest requested delay", () => {
    const first = createNextRunDeferral();
    const second = createNextRunDeferral();
    expect(first.delayMs).toBeUndefined();
    first.deferNextRun({ seconds: 2 });
    first.deferNextRun({ seconds: 1 });
    expect(first.delayMs).toBe(2_000);
    first.deferNextRun({ seconds: 3 });
    expect(first.delayMs).toBe(3_000);
    expect(second.delayMs).toBeUndefined();
    expect(() => first.deferNextRun({ seconds: -1 })).toThrow(TypeError);
    expect(first.delayMs).toBe(3_000);
  });
});
