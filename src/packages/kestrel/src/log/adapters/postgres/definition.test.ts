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
});
