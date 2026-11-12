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
  let destination = first;
  const logger = createDelegatingLogger(() => destination);
  const child = logger.child({ scope: "first" }).child({ task: "report" });
  expect("level" in logger).toBe(true);
  expect("unknown" in logger).toBe(false);
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
  logger.level = "error";
  expect(first.level).toBe("error");
  destination = second;
  expect(logger.level).toBe("silent");
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
  expect(child.bindings()).toEqual({ scope: "first", task: "report" });
});

it("removes a workload binding when the execution context stops declaring a supported workload", () => {
  const context = new ExecutionContext();
  const logger = createExecutionWorkloadLogger(pino({ level: "silent" }), context);
  expect(logger.bindings()).toEqual({});
  context.setDiagnostic("workload", "workers", { destinations: [executionContextLogDestination] });
  expect(logger.bindings()).toEqual({ workload: "workers" });
  context.setDiagnostic("workload", "custom", { destinations: [executionContextLogDestination] });
  expect(logger.bindings()).toEqual({});
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
