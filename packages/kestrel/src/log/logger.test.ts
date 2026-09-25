import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { ExecutionContext } from "../app/index.js";
import {
  createDynamicExecutionLogger,
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
