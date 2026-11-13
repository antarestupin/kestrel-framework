import { describe, expect, it } from "vitest";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { defineHistoryTable } from "./definition.js";
import { readHistoryPage } from "./reader.js";

const source = pgTable("entry", { tenant: text("tenant").notNull(), id: text("id").notNull(), title: text("title"), secret: text("secret"), count: bigint("count", { mode: "bigint" }) });
const createHistory = () => defineHistoryTable(source, { identity: [source.tenant, source.id] });

/** Inject a bounded query result without mocking module imports or database state. */
function database(rows: Record<string, unknown>[]) {
  let selection: unknown;
  let condition: unknown;
  let limit = 0;
  const query = {
    from: () => query, where: (value: unknown) => { condition = value; return query; },
    orderBy: () => query, limit: (value: number) => { limit = value; return Promise.resolve(rows); },
  };
  return { client: { select: (value: unknown) => { selection = value; return query; } } as unknown as Parameters<typeof readHistoryPage>[0],
    inspect: () => ({ selection, condition, limit }) };
}
const event = (sequence: bigint, operation = "update") => ({ __sequence: sequence, __operation: operation,
  __changedColumns: ["title"], __changedAt: new Date("2026-10-01Z"), __actor: null, __reason: "Correction", title: null });

describe("sparse history reader", () => {
  it("preserves explicit NULL and bigint cursors, bounds pages and projects only selected fields", async () => {
    const table = createHistory();
    const db = database([event(9007199254740993n), event(2n)]);
    const page = await readHistoryPage(db.client, table, { identity: { tenant: "t", id: "i" }, fields: ["title"], pageSize: 1, before: "9007199254740994" });
    expect(page.events[0]?.values).toEqual({ title: null });
    expect(page.nextCursor).toBe("9007199254740993");
    expect(db.inspect().limit).toBe(2);
    expect(Object.keys(db.inspect().selection as object)).not.toContain("secret");
    const sql = new PgDialect().sqlToQuery(db.inspect().condition as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql.params).toEqual(["t", "i", 9007199254740994n]);
  });
  it("leaves unchanged values absent and deletions empty", async () => {
    const table = createHistory();
    const db = database([{ ...event(3n), __changedColumns: [] }, event(2n, "delete")]);
    const page = await readHistoryPage(db.client, table, { identity: { tenant: "t", id: "i" }, fields: ["title"] });
    expect(page.events.map((item) => item.values)).toEqual([{}, {}]);
    expect(page.nextCursor).toBeNull();
  });
  it("serializes changed bigint column values without losing precision", async () => {
    const table = createHistory();
    const db = database([{ ...event(4n), __changedColumns: ["count"], count: 9007199254740993n }]);
    const page = await readHistoryPage(db.client, table, { identity: { tenant: "t", id: "i" }, fields: ["count"] });
    expect(page.events[0]?.values).toEqual({ count: "9007199254740993" });
  });
  it("rejects invalid identities, fields, page sizes and cursors before reading", async () => {
    const table = createHistory();
    const db = database([]);
    const request = { identity: { tenant: "t", id: "i" }, fields: ["title"] };
    for (const override of [{ identity: { id: "i" } }, { fields: ["missing"] }, { pageSize: 101 }, { before: "9223372036854775808" }]) {
      await expect(readHistoryPage(db.client, table, { ...request, ...override })).rejects.toThrow();
    }
    await expect(readHistoryPage(db.client, source, request)).rejects.toThrow("defineHistoryTable");
  });

  it("validates page boundaries, cursor syntax, and explicit identity ownership", async () => {
    const table = createHistory();
    const db = database([]);
    const request = { identity: { tenant: "t", id: "i" }, fields: ["title"] };
    for (const pageSize of [0, 1.5, Number.NaN, 101]) {
      await expect(readHistoryPage(db.client, table, { ...request, pageSize })).rejects.toThrow("Invalid history page size.");
    }
    for (const before of ["0", "01", " 1", "1 ", "1x", "9223372036854775808"]) {
      await expect(readHistoryPage(db.client, table, { ...request, before })).rejects.toThrow("Invalid history cursor.");
    }
    for (const identity of [{ tenant: null, id: "i" }, Object.create({ tenant: "t", id: "i" })]) {
      await expect(readHistoryPage(db.client, table, { ...request, identity })).rejects.toThrow("Missing history identity.");
    }
    await expect(readHistoryPage(db.client, table, { ...request, fields: ["title", "missing"] })).rejects.toThrow("Unknown history field.");
    expect(db.inspect().selection).toBeUndefined();

    await readHistoryPage(db.client, table, { ...request, before: "9223372036854775807", pageSize: 100 });
    expect(db.inspect().limit).toBe(101);
  });

  it("returns each selected field once and omits a cursor on an exactly full last page", async () => {
    const table = createHistory();
    const db = database([event(9n)]);
    const result = await readHistoryPage(db.client, table, {
      identity: { tenant: "t", id: "i" }, fields: ["title", "title"], pageSize: 1,
    });
    expect(result).toEqual({
      fields: ["title"], nextCursor: null, events: [{
        sequence: "9", changedAt: "2026-10-01T00:00:00.000Z", operation: "update",
        actor: null, reason: "Correction", values: { title: null },
      }],
    });
  });
});
