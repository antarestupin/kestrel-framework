import { defineLoggerAdapter } from "./adapter_definition.js";
import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { App, executionContextDependency, setExecutionLogContext } from "../app/index.js";
import { dep } from "../di/index.js";
import {
  applicationLoggerDependency,
  loggerDependency,
  setExecutionLogEnabledDependency,
} from "./dependencies.js";
import type { LoggerConfig } from "./configuration.js";
import type { OwnedLogger } from "./logger.js";
import { LoggerProvider } from "./provider.js";

describe("LoggerProvider", () => {
  it("keeps a silent facade until bootstrap selects the configured backend", async () => {
    const app = createTestApp("info");

    expect(app.container.resolve(applicationLoggerDependency).level).toBe("silent");
    await app.start();
    expect(app.container.resolve(applicationLoggerDependency).level).toBe("info");

    await app.dispose();
  });

  it("logs one structured application startup summary", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(
      new CapturingLoggerProvider(lines, "completion", true, "debug"),
    );

    app.prepareBootPlan(["workers"], "standard", "worker");
    await app.start();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      msg: "App started",
      runtime: "worker",
      durations: {
        bootstrapMs: expect.any(Number),
        compositionMs: expect.any(Number),
        totalMs: expect.any(Number),
        providers: {
          boot: [expect.objectContaining({ provider: "CapturingLoggerProvider" })],
          composition: [expect.objectContaining({ provider: "CapturingLoggerProvider" })],
        },
      },
    });
    await app.dispose();
  });

  it("creates one correlated child logger per execution", async () => {
    const app = createTestApp("silent");
    await app.start();
    const firstExecution = await app.createExecutionScope("first-execution");
    const secondExecution = await app.createExecutionScope("second-execution");
    const first = firstExecution.container.resolve(loggerDependency);

    setExecutionLogContext(firstExecution.context, {
      operation: "example.run",
      transport: "worker",
      workload: "workers",
    });

    expect(firstExecution.container.resolve(loggerDependency)).toBe(first);
    expect(secondExecution.container.resolve(loggerDependency)).not.toBe(first);
    expect(first.bindings()).toMatchObject({
      executionId: "first-execution",
      workload: "workers",
    });

    await firstExecution.dispose();
    await secondExecution.dispose();
    await app.dispose();
  });

  it("closes the owned logger resource on disposal", async () => {
    const app = createTestApp("silent");
    const resource = app.container.resolve(dep<OwnedLogger>("loggerResource"));
    const close = vi.spyOn(resource, "close");

    await app.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it("logs one tagged context summary when an execution completes", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(new CapturingLoggerProvider(lines));

    await app.start();
    const execution = await app.createExecutionScope("execution-1");

    execution.container
      .resolve(executionContextDependency)
      .setDiagnostic("userId", "user-1", { destinations: ["log"] });
    execution.context.setDiagnostic("observationOnly", true, {
      destinations: ["observation"],
    });
    execution.context.setDiagnostic("operation", "example.run", {
      destinations: ["log"],
    });
    execution.context.setDiagnostic("transport", "direct", {
      destinations: ["log"],
    });
    execution.context.setDiagnostic("workload", "workers", {
      destinations: ["log"],
    });

    await execution.dispose("success");

    const entry = parseLogLines(lines).find(({ msg }) => msg === "Execution context completed");

    expect(entry).toMatchObject({
      executionContext: {
        userId: "user-1",
      },
      executionId: "execution-1",
      operation: "example.run",
      outcome: "success",
      transport: "direct",
      workload: "workers",
      msg: "Execution context completed",
    });
    await app.dispose();
  });

  it("can enrich each subsequent scoped log instead of logging a summary", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(new CapturingLoggerProvider(lines, "dynamic"));

    await app.start();
    const execution = await app.createExecutionScope("execution-1");
    const logger = execution.container.resolve(loggerDependency);

    execution.context.setDiagnostic("userId", "user-1", {
      destinations: ["log"],
    });
    execution.context.setDiagnostic("workload", "scheduled-tasks", {
      destinations: ["log"],
    });
    logger.info("Processing user");
    await execution.dispose();

    const entry = parseLogLines(lines).find(({ msg }) => msg === "Processing user");

    expect(entry).toMatchObject({
      executionContext: {
        userId: "user-1",
      },
      executionId: "execution-1",
      msg: "Processing user",
      workload: "scheduled-tasks",
    });
    await app.dispose();
  });

  it("lets an execution scope suppress its completion log", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(new CapturingLoggerProvider(lines));

    await app.start();
    const execution = await app.createExecutionScope("execution-1");

    execution.container.resolve(setExecutionLogEnabledDependency)(false);
    await execution.dispose();

    expect(lines).toEqual([]);
    await app.dispose();
  });

  it("does not let a local override bypass the global policy", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(
      new CapturingLoggerProvider(lines, "completion", false),
    );

    await app.start();
    const execution = await app.createExecutionScope("execution-1");

    execution.container.resolve(setExecutionLogEnabledDependency)(true);
    await execution.dispose();

    expect(lines).toEqual([]);
    await app.dispose();
  });

  it("applies scoped suppression to dynamic context enrichment", async () => {
    const lines: string[] = [];
    const app = new App({ name: "test" }).register(new CapturingLoggerProvider(lines, "dynamic"));

    await app.start();
    const execution = await app.createExecutionScope("execution-1");
    const logger = execution.container.resolve(loggerDependency);
    const setExecutionLogEnabled = execution.container.resolve(setExecutionLogEnabledDependency);

    setExecutionLogEnabled(false);
    logger.info("Technical work");
    setExecutionLogEnabled(true);
    logger.info("Visible work");
    await execution.dispose();

    const entries = parseLogLines(lines);
    const technicalEntry = entries.find(({ msg }) => msg === "Technical work");
    const visibleEntry = entries.find(({ msg }) => msg === "Visible work");

    expect(technicalEntry).toMatchObject({ msg: "Technical work" });
    expect(technicalEntry?.executionContext).toBeUndefined();
    expect(visibleEntry).toMatchObject({
      msg: "Visible work",
      executionId: "execution-1",
    });
    expect(visibleEntry?.executionContext).toBeUndefined();
    await app.dispose();
  });
});

/** Replaces stdout with an in-memory destination for provider integration tests. */
class CapturingLoggerProvider extends LoggerProvider<{ name: string }> {
  public constructor(
    private readonly lines: string[],
    contextMode: "completion" | "dynamic" = "completion",
    enabled = true,
    private readonly level: LoggerConfig["level"] = "info",
  ) {
    super(
      { level, developmentStorage: false, executionLog: { enabled, contextMode } },
      defineLoggerAdapter({
        dependencies: {},
        capabilities: {},
        create: () => ({
          logger: pino(
            { level },
            new Writable({
              write: (chunk, _encoding, callback) => {
                lines.push(chunk.toString());
                callback();
              },
            }),
          ),
          close: async () => {},
        }),
        dispose: (value) => value.close(),
      }),
    );
  }
}

function createTestApp(level: LoggerConfig["level"]): App<{ name: string }> {
  return new App({ name: "test" }).register(
    new CapturingLoggerProvider([], "completion", true, level),
  );
}

/** Parses captured JSON lines so assertions can select the relevant message. */
function parseLogLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line));
}
