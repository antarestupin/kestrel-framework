import { Writable } from "node:stream";

import type { Pool } from "pg";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { createDependencyContainer, dep } from "../../../di/index.js";
import { loggerConfigBase } from "../../configuration.js";
import { createDevLogger } from "../../logger.js";
import { postgresLogger } from "./definition.js";

const settings = { host: "db.example.test", port: 5432, user: "local", password: "test", database: "app", ssl: false };
const config = loggerConfigBase.schema.parse({ level: "warn" });
const database = dep<{ pool: Pool }>("database");

/** Record the worker boundary without opening PostgreSQL connections in this unit suite. */
function fakeTransport() {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
  const transport = vi.spyOn(pino, "transport").mockReturnValue(sink as unknown as ReturnType<typeof pino.transport>);
  return { sink, lines, transport };
}

describe("PostgreSQL logger definition", () => {
  it.each([
    { runningMode: "minimal" as const, failure: undefined },
    { runningMode: "standard" as const, failure: { code: "42P01" } },
    { runningMode: "standard" as const, failure: { code: "08006" } },
    { runningMode: "standard" as const, failure: {} },
    { runningMode: "standard" as const, failure: null },
    { runningMode: "standard" as const, failure: "unavailable" },
  ])("only tolerates missing local log tables in $runningMode mode", async ({ runningMode, failure }) => {
    const query = vi.fn(async () => { throw failure; });
    const container = createDependencyContainer({});
    container.registerValue(database.id, { pool: { query } });
    const { transport, sink } = fakeTransport();
    const definition = postgresLogger(database, settings);
    const logger = definition.create(container.resolve.bind(container), {
      config, bootPlan: { runningMode, workloads: [], runtime: "command" },
    });

    try {
      if (runningMode === "minimal" || (failure && typeof failure === "object" && "code" in failure && failure.code === "42P01")) {
        await expect(definition.initialize?.(logger)).resolves.toBeUndefined();
      } else {
        await expect(definition.initialize?.(logger)).rejects.toBe(failure);
      }
      expect(query).toHaveBeenCalledTimes(runningMode === "minimal" ? 0 : 1);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await definition.dispose?.(logger);
      await container.dispose();
      transport.mockRestore();
      sink.destroy();
    }
  });

  it("switches existing child loggers only after readiness and closes the owned worker", async () => {
    const { transport, sink, lines } = fakeTransport();
    const query = vi.fn(async () => ({ rows: [] }));
    const container = createDependencyContainer({});
    container.registerValue(database.id, { pool: { query } });
    const definition = postgresLogger(database, settings);
    const resource = definition.create(container.resolve.bind(container), {
      config, bootPlan: { runningMode: "standard", workloads: [], runtime: "command" },
    });
    const child = resource.logger.child({ subsystem: "fixture" });

    try {
      expect(transport).not.toHaveBeenCalled();
      expect(child.level).toBe("warn");
      await definition.initialize?.(resource);
      child.info("Below configured level");
      child.warn("Visible");
      expect(query).toHaveBeenCalledExactlyOnceWith("select 1 from dev.log limit 1");
      expect(transport).toHaveBeenCalledExactlyOnceWith({
        target: expect.stringMatching(/postgres_transport\.ts$/), options: settings,
      });
      expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ msg: "Visible", subsystem: "fixture" }]);
      await definition.dispose?.(resource);
      await definition.dispose?.(resource);
      expect(sink.closed).toBe(true);
    } finally {
      await definition.dispose?.(resource);
      await container.dispose();
      transport.mockRestore();
      sink.destroy();
    }
  });

  it("uses Pino defaults when building an owned development logger directly", async () => {
    const { transport, sink, lines } = fakeTransport();
    const resource = createDevLogger(settings);
    try {
      resource.logger.info("Default level");
      expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ msg: "Default level", level: 30 }]);
    } finally {
      await resource.close();
      transport.mockRestore();
      sink.destroy();
    }
  });

  it("shares completion of a worker close with concurrent callers", async () => {
    const finish = Promise.withResolvers<void>();
    const sink = new Writable({
      final(done) { void finish.promise.then(() => done()); },
    });
    const transport = vi.spyOn(pino, "transport").mockReturnValue(sink as unknown as ReturnType<typeof pino.transport>);
    const end = vi.spyOn(sink, "end");
    const resource = createDevLogger(settings);

    try {
      const first = resource.close();
      const second = resource.close();

      expect(second).toBe(first);
      expect(sink.closed).toBe(false);
      expect(end).toHaveBeenCalledOnce();

      finish.resolve();
      await Promise.all([first, second]);
      expect(sink.closed).toBe(true);
      expect(resource.close()).toBe(first);
    } finally {
      finish.resolve();
      await resource.close();
      transport.mockRestore();
      sink.destroy();
    }
  });

  it("reports a worker error outside the stream callback as a fatal failure", async () => {
    const { transport, sink } = fakeTransport();
    const resource = createDevLogger(settings);
    const queued: VoidFunction[] = [];
    const schedule = vi.spyOn(globalThis, "queueMicrotask").mockImplementationOnce((task) => queued.push(task));
    const failure = new Error("worker failed");

    try {
      sink.emit("error", failure);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toThrow(failure);
    } finally {
      schedule.mockRestore();
      await resource.close();
      transport.mockRestore();
      sink.destroy();
    }
  });
});
