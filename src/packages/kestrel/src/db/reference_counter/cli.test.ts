import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../app/index.js";
import { buildCli } from "../../cli/runner.js";
import { postgresDrizzleConfigBase } from "../configuration.js";
import { PostgresDrizzleProvider } from "../provider.js";
import { defineReferenceCounter } from "./definition.js";

function application() {
  const parent = pgTable("parent", { id: integer("id").primaryKey(), count: integer("count").notNull().default(0) });
  const child = pgTable("child", { parentId: integer("parent_id").references(() => parent.id) });
  defineReferenceCounter(child, { id: "parent.count", reference: child.parentId, target: parent.id, counter: parent.count });
  const createDatabase = vi.fn(() => drizzle.mock());
  const app = new App({}).register(new PostgresDrizzleProvider(
    postgresDrizzleConfigBase.schema.parse({ host: "localhost", database: "unused", user: "unused", password: "unused" }),
    { schema: { parent, child }, createDatabase },
  ));
  const output: string[] = [];
  const errors: string[] = [];
  const cli = buildCli(app, { writeOutput: (text) => output.push(text), writeError: (text) => errors.push(text) });
  return { app, cli, output, errors, createDatabase };
}

describe("reference counter CLI", () => {
  it("shows help without constructing database resources", async () => {
    const test = application();
    try {
      expect(await test.cli.run(["database", "counter", "rebuild", "--help"])).toBe(0);
      expect(test.output.join("")).toContain("--batch-size");
      expect(test.output.join("")).toContain("--after");
      expect(test.createDatabase).not.toHaveBeenCalled();
    } finally { await test.app.dispose(); }
  });

  it.each([{ args: [] }, { args: ["--id=parent.count", "--batch-size=0"] }, { args: ["--id=parent.count", "--pause-ms=-1"] }])("validates arguments before resolving database dependencies: $args", async ({ args }) => {
    const test = application();
    try {
      expect(await test.cli.run(["database", "counter", "rebuild", ...args])).toBe(2);
      expect(test.createDatabase).not.toHaveBeenCalled();
    } finally { await test.app.dispose(); }
  });

  it("reports an unknown id as an input error and releases signal listeners", async () => {
    const test = application();
    const interrupts = process.listenerCount("SIGINT");
    const terminations = process.listenerCount("SIGTERM");
    try {
      expect(await test.cli.run(["database", "counter", "rebuild", "--id=missing"])).toBe(2);
      expect(test.errors.join("")).toContain('Unknown reference counter "missing"');
      expect(process.listenerCount("SIGINT")).toBe(interrupts);
      expect(process.listenerCount("SIGTERM")).toBe(terminations);
    } finally { await test.app.dispose(); }
  });
});
