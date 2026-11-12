import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ExecutionContext } from "../app/index.js";
import {
  createDelegatingLogger,
  createDynamicExecutionLogger,
  createExecutionWorkloadLogger,
  createLogger,
  executionContextLogDestination,
  projectExecutionLogContext,
} from "./logger.js";

describe("dynamic execution logger", () => {
  it("adds the latest tagged values to subsequent calls and derived children", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const context = new ExecutionContext();
    const logger = createDynamicExecutionLogger(
      pino({ level: "info" }, destination),
      context,
    );

    logger.info("Before context");
    context.setDiagnostic("userId", "user-1", {
      destinations: [executionContextLogDestination],
    });
    context.setDiagnostic("observationOnly", true, {
      destinations: ["observation"],
    });
    logger.info({ requestId: "request-1" }, "After context");
    logger.child({ component: "child" }).warn("From child");

    const entries = lines.map((line) => JSON.parse(line) as {
      executionContext?: unknown;
      requestId?: string;
      component?: string;
    });

    expect(entries[0]?.executionContext).toBeUndefined();
    expect(entries[1]).toMatchObject({
      requestId: "request-1",
      executionContext: { userId: "user-1" },
    });
    expect(entries[2]).toMatchObject({
      component: "child",
      executionContext: { userId: "user-1" },
    });
  });

  it("promotes standard metadata and keeps only additional contributed context", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const context = new ExecutionContext();

    context.setDiagnostic("executionId", "execution-1", {
      destinations: ["log"],
    });
    context.setDiagnostic("operation", "example.run", {
      destinations: ["log"],
    });
    context.setDiagnostic("transport", "direct", {
      destinations: ["log"],
    });
    context.setDiagnostic("userId", "user-1", {
      destinations: ["log"],
    });

    createDynamicExecutionLogger(
      pino({ level: "info" }, destination).child({
        executionId: "execution-1",
      }),
      context,
    ).info("Run example");

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      executionId: "execution-1",
      operation: "example.run",
      transport: "direct",
      executionContext: { userId: "user-1" },
    });
  });

  it("passes dynamic diagnostics through Pino's redaction policy before writing", () => {
    const lines: string[] = [];
    const destination = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
    const context = new ExecutionContext();
    context.setDiagnostic("token", "context-secret", { destinations: [executionContextLogDestination] });
    context.setDiagnostic("correlation", "kept", { destinations: [executionContextLogDestination] });
    const logger = createDynamicExecutionLogger(pino({
      redact: { paths: ["executionContext.token", "secret"], remove: true },
    }, destination), context);

    logger.child({ channel: "child" }).info({ secret: "call-secret" }, "Filtered");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ msg: "Filtered", channel: "child", executionContext: { correlation: "kept" } });
    expect(entry).not.toHaveProperty("secret");
    expect(entry.executionContext).not.toHaveProperty("token");
  });
});

it("preserves Error, null and message overloads while keeping context on derived children", () => {
  const lines: string[] = [];
  const destination = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
  const context = new ExecutionContext();
  context.setDiagnostic("operation", "example.run", { destinations: [executionContextLogDestination] });
  context.setDiagnostic("transport", 42, { destinations: [executionContextLogDestination] });
  const logger = createDynamicExecutionLogger(pino({ level: "info" }, destination), context);

  logger.child({ worker: "reports" }).error(new Error("rejected"), "Operation failed");
  logger.info(null, "Null binding");
  logger.info("Received %s", "message");
  expect(logger.isLevelEnabled("info")).toBe(true);
  expect(logger.level).toBe("info");
  const entries = lines.map((line) => JSON.parse(line));
  expect(entries).toMatchObject([
    { worker: "reports", operation: "example.run", err: { message: "rejected" }, msg: "Operation failed" },
    { operation: "example.run", msg: "Null binding" },
    { operation: "example.run", msg: "Received message" },
  ]);
  expect(entries[2]).not.toHaveProperty("transport");
});

it("keeps derived bindings and logger property writes when the destination changes", () => {
  const first = pino({ level: "silent" });
  const second = pino({ level: "silent" });
  const firstChild = vi.spyOn(first, "child");
  const secondChild = vi.spyOn(second, "child");
  let destination = first;
  const logger = createDelegatingLogger(() => destination);
  const child = logger.child({ scope: "first" }).child({ task: "report" });
  expect("level" in logger).toBe(true);
  expect("unknown" in logger).toBe(false);
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
  const bindings = child.bindings;
  expect(bindings()).toEqual({ scope: "first", task: "report" });
  expect(firstChild.mock.calls).toEqual([[{ scope: "first" }], [{ task: "report" }]]);
  logger.level = "error";
  expect(first.level).toBe("error");
  destination = second;
  expect(logger.level).toBe("silent");
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
  expect(secondChild.mock.calls).toEqual([[{ scope: "first" }], [{ task: "report" }]]);
});

it("retries a child against the new destination after child creation fails", () => {
  const first = pino({ level: "silent" }).child({ destination: "first" });
  const second = pino({ level: "silent" }).child({ destination: "second" });
  const failure = new Error("child serializer unavailable");
  const createChild = vi.spyOn(second, "child").mockImplementationOnce(() => { throw failure; });
  let active = first;
  const child = createDelegatingLogger(() => active).child({ task: "report" });

  expect(child.bindings()).toEqual({ destination: "first", task: "report" });
  active = second;
  expect(() => child.bindings()).toThrow(failure);
  expect(child.bindings()).toEqual({ destination: "second", task: "report" });
  expect(createChild).toHaveBeenCalledTimes(2);
});

it("removes a workload binding when the execution context stops declaring a supported workload", () => {
  const context = new ExecutionContext();
  const parent = pino({ level: "silent" });
  const child = vi.spyOn(parent, "child");
  const logger = createExecutionWorkloadLogger(parent, context);
  expect(logger.bindings()).toEqual({});
  context.setDiagnostic("workload", "workers", { destinations: [executionContextLogDestination] });
  expect(logger.bindings()).toEqual({ workload: "workers" });
  expect(logger.bindings()).toEqual({ workload: "workers" });
  context.setDiagnostic("workload", "custom", { destinations: [executionContextLogDestination] });
  expect(logger.bindings()).toEqual({});
  expect(child).toHaveBeenCalledExactlyOnceWith({ workload: "workers" });
});

it("preserves Pino's original hook arguments when context is absent or disabled", () => {
  const entries: unknown[][] = [];
  const parent = pino({ hooks: { logMethod(args) { entries.push(args); } } });
  const context = new ExecutionContext();
  let enabled = true;
  const logger = createDynamicExecutionLogger(parent, context, () => enabled);

  logger.info("Before %s", "context");
  context.setDiagnostic("userId", "user-1", { destinations: [executionContextLogDestination] });
  enabled = false;
  logger.info("While %s", "disabled");
  enabled = true;
  logger.info("With %s", "context");

  expect(entries).toEqual([
    ["Before %s", "context"],
    ["While %s", "disabled"],
    [{ executionContext: { userId: "user-1" } }, "With %s", "context"],
  ]);
  const bindings = logger.bindings;
  expect(bindings()).toEqual({});
});

it("omits malformed reserved execution metadata from projected log fields", () => {
  const context = new ExecutionContext();
  for (const key of ["operation", "transport", "workload"]) {
    context.setDiagnostic(key, { invalid: true }, { destinations: [executionContextLogDestination] });
  }
  context.setDiagnostic("source", "audit", { destinations: [executionContextLogDestination] });

  expect(projectExecutionLogContext(context)).toStrictEqual({ executionContext: { source: "audit" } });
});

it("reports Pino flush failures when closing the standard logger", async () => {
  const resource = createLogger({ level: "silent" });
  const failure = new Error("stdout flush failed");
  const flush = vi.spyOn(resource.logger, "flush").mockImplementation((done) => done?.(failure));
  try {
    await expect(resource.close()).rejects.toBe(failure);
  } finally {
    flush.mockRestore();
    await resource.close();
  }
});
