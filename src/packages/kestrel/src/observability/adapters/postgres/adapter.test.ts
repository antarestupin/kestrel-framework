import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { executionCompletedObservation, executionStartedObservation } from "../../../app/observations.js";
import { createDependencyContainer, dep } from "../../../di/index.js";
import type { ObservationRecord } from "../../source.js";
import { postgresObservations } from "./definition.js";
import { PostgresObservationStore } from "./adapter.js";

describe("PostgresObservationStore", () => {
  it("loads complete timelines for executions matching a diagnostic context", async () => {
    const query = vi.fn(async (..._arguments: unknown[]) => ({ rows: [] }));
    const store = new PostgresObservationStore({
      query,
    } as unknown as Pool);

    await store.listEventsByContext("workflow.executionId", "workflow-1");

    expect(query).toHaveBeenCalledOnce();
    const [statement] = query.mock.calls[0] as [string | { text: string }];
    const sql = typeof statement === "string" ? statement : statement?.text;

    expect(sql).toContain(
      `"dev"."observation"."execution_id" in (select "execution_id" from "dev"."observation" where "dev"."observation"."data"->'context'->>$1 = $2)`,
    );
  });
});

const observedAt = "2026-01-01T00:00:00.000Z";
const completedAt = "2026-01-01T00:00:01.000Z";

/** Driver rows follow Drizzle's selected-column order and contain real PostgreSQL wire values. */
function row(sequence: number, executionId: string, overrides: Partial<ObservationRecord> = {}) {
  return [String(sequence), `event-${sequence}`, executionId,
    (overrides.occurredAt ?? new Date(observedAt)).toISOString(),
    overrides.name ?? "example.event", "application", 1,
    overrides.outcome ?? null, overrides.durationMs ?? null, overrides.data ?? {}, observedAt];
}

function fixture() {
  const query = vi.fn(async (_query: string | { text: string }, _values?: readonly unknown[]): Promise<{ rows: unknown[][] }> => ({ rows: [] }));
  const pool = { query } as unknown as Pool;
  const store = new PostgresObservationStore(pool);
  const statement = (call: number) => {
    const input = query.mock.calls[call]?.[0];
    return typeof input === "string" ? input : input?.text;
  };
  return { pool, query, statement, store };
}

describe("PostgreSQL observation persistence", () => {
  it("prepares retention and writes optional metadata while skipping empty batches", async () => {
    const { query, statement, store } = fixture();
    await store.prepare(3);
    await store.append([]);
    const event = {
      id: "event-1", executionId: "execution", occurredAt: new Date(observedAt),
      name: "example.event", category: "application", schemaVersion: 1, data: { count: 4 },
    };
    await store.append([event, { ...event, id: "event-2", outcome: "success", durationMs: 0 }]);
    await store.clear();

    expect(query).toHaveBeenNthCalledWith(1, "select 1 from dev.observation limit 1");
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("delete from dev.observation"), [3]);
    expect(statement(2)).toContain('insert into "dev"."observation"');
    expect(query.mock.calls[2]?.[1]).toEqual([
      "event-1", "execution", observedAt, "example.event", "application", 1, '{"count":4}',
      "event-2", "execution", observedAt, "example.event", "application", 1, "success", 0, '{"count":4}',
    ]);
    expect(statement(3)).toBe('delete from "dev"."observation"');
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("reads event detail and the entire execution timeline in event order", async () => {
    const { query, statement, store } = fixture();
    query.mockResolvedValueOnce({ rows: [row(2, "execution", { data: { nested: { count: 1 } } })] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [row(1, "execution"), row(2, "execution")] });
    await expect(store.getObservation("event-2")).resolves.toMatchObject({
      sequence: 2, id: "event-2", occurredAt: new Date(observedAt), data: { nested: { count: 1 } },
    });
    await expect(store.getObservation("missing")).resolves.toBeUndefined();
    await expect(store.listEvents("execution")).resolves.toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
    expect(query.mock.calls[0]?.[1]).toEqual(["event-2", 1]);
    expect(query.mock.calls[2]?.[1]).toEqual(["execution"]);
    expect(statement(2)).toContain('order by "dev"."observation"."occurred_at" asc, "dev"."observation"."sequence" asc');
  });

  it("uses exact filters and a bounded keyset cursor for observation pages", async () => {
    const { query, statement, store } = fixture();
    query.mockResolvedValueOnce({ rows: [row(8, "execution"), row(7, "execution")] });
    await expect(store.listObservations({
      before: 9, category: "application", executionId: "execution", name: "example.event", outcome: "success", limit: 0,
    })).resolves.toMatchObject({ items: [{ sequence: 8 }], nextBefore: 8 });
    expect(query.mock.calls[0]?.[1]).toEqual([9, "application", "execution", "example.event", "success", 2]);
    expect(statement(0)).toContain('"dev"."observation"."sequence" < $1');
    expect(statement(0)).toContain('order by "dev"."observation"."sequence" desc');
    await expect(store.listObservations({ limit: 200 })).resolves.toEqual({ items: [], nextBefore: null });
    await expect(store.listObservations()).resolves.toEqual({ items: [], nextBefore: null });
    expect(query.mock.calls[1]?.[1]).toEqual([101]);
    expect(query.mock.calls[2]?.[1]).toEqual([51]);
  });

  it("joins lifecycle events without filling missing completion data or exposing invalid transports", async () => {
    const { query, statement, store } = fixture();
    query.mockResolvedValueOnce({ rows: [
      row(9, "web", { data: { operation: "render", transport: "http" } }),
      row(8, "legacy", { data: { operation: 42, transport: "custom" } }),
      row(7, "earlier"),
    ] });
    query.mockResolvedValueOnce({ rows: [row(10, "web", {
      occurredAt: new Date(completedAt), outcome: "success", durationMs: 1_000,
    })] });

    await expect(store.listExecutions({ before: 12, limit: 2 })).resolves.toEqual({
      items: [
        { executionId: "web", operation: "render", transport: "http", startedAt: new Date(observedAt), completedAt: new Date(completedAt), outcome: "success", durationMs: 1_000 },
        { executionId: "legacy", operation: "Unknown execution", transport: "direct", startedAt: new Date(observedAt), completedAt: null, outcome: null, durationMs: null },
      ], nextBefore: 8,
    });
    expect(statement(0)).toContain('"dev"."observation"."sequence" < $2');
    expect(query.mock.calls[0]?.[1]).toEqual([executionStartedObservation.name, 12, 3]);
    expect(query.mock.calls[1]?.[1]).toEqual([executionCompletedObservation.name, "web", "legacy"]);
    await expect(store.listExecutions()).resolves.toEqual({ items: [], nextBefore: null });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each(["cli", "direct", "worker"] as const)("preserves the %s execution transport", async (transport) => {
    const { query, store } = fixture();
    query.mockResolvedValueOnce({ rows: [row(1, "execution", { data: { operation: "run", transport } })] });
    await expect(store.listExecutions()).resolves.toMatchObject({ items: [{ operation: "run", transport }], nextBefore: null });
  });

  it("keeps the latest completion when an execution emits more than one", async () => {
    const { query, store } = fixture();
    query.mockResolvedValueOnce({ rows: [row(1, "execution")] });
    query.mockResolvedValueOnce({ rows: [
      row(3, "execution", { outcome: "success", occurredAt: new Date(completedAt) }),
      row(2, "execution", { outcome: "failure" }),
    ] });
    await expect(store.listExecutions()).resolves.toMatchObject({
      items: [{ executionId: "execution", outcome: "success", completedAt: new Date(completedAt) }],
    });
  });

  it.each([undefined, { code: "42P01" }, { code: "08006" }, null, "broken"])("prepares the optional adapter without swallowing unexpected failures (%j)", async (failure) => {
    const { pool, query } = fixture();
    const connection = dep<{ readonly pool: Pool }>("database");
    const container = createDependencyContainer({});
    container.registerValue(connection.id, { pool });
    const definition = postgresObservations(connection, { retentionDays: 5 });
    const adapter = definition.create(container.resolve.bind(container), undefined);
    if (failure !== undefined) query.mockRejectedValueOnce(failure);
    try {
      if (failure === undefined || (failure !== null && typeof failure === "object" && failure.code === "42P01")) {
        await expect(definition.initialize?.(adapter)).resolves.toBeUndefined();
        expect(adapter.available).toBe(failure === undefined);
        expect(adapter.writer).toBe(adapter.source);
      } else {
        await expect(definition.initialize?.(adapter)).rejects.toBe(failure);
      }
    } finally {
      await container.dispose();
    }
  });
});
