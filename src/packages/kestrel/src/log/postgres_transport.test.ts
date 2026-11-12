import { once } from "node:events";

import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import createPostgresTransport from "./postgres_transport.js";

/** Record the PostgreSQL boundary while using the real JSON transport stream. */
function fakePool() {
  const query = vi.fn(async (_statement: string, _parameters?: readonly unknown[]) => ({ rows: [] }));
  vi.spyOn(Pool.prototype, "query").mockImplementation(query as unknown as Pool["query"]);
  const end = vi.spyOn(Pool.prototype, "end").mockImplementation(async () => undefined);
  return { query, end };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PostgreSQL log transport", () => {
  it.each([1, 2])("releases the worker pool when startup query %s fails", async (failingQuery) => {
    const { query, end } = fakePool();
    const unavailable = new Error("local log table unavailable");
    if (failingQuery === 2) query.mockResolvedValueOnce({ rows: [] });
    query.mockRejectedValueOnce(unavailable);

    await expect(createPostgresTransport({})).rejects.toBe(unavailable);
    expect(end).toHaveBeenCalledOnce();
  });

  it("batches records and skips log viewer traffic through its terminal events", async () => {
    const { query, end } = fakePool();
    const stream = await createPostgresTransport({ batchSize: 2, retentionDays: 3 });
    const closed = once(stream, "close");
    const log = (record: unknown) => stream.write(`${JSON.stringify(record)}\n`);
    const url = "/api/extensions/development-logs/logs";

    try {
      log({ reqId: "viewer-a", req: { url } });
      log({ requestId: "viewer-b", req: { url } });
      log({ req: { url } });
      log({ reqId: "viewer-a", msg: "intermediate" });
      log({ requestId: "viewer-b", msg: "request errored" });
      log({ reqId: "viewer-a", msg: "request completed" });
      log({ reqId: "viewer-a", level: 50, time: 1_000, msg: "released id" });
      log({ requestId: "viewer-b", level: 40, time: 2_000, msg: "second id" });
      log({ component: "standalone" });
      stream.end();
      await closed;
    } finally {
      stream.destroy();
    }

    expect(query).toHaveBeenNthCalledWith(1, "select 1 from dev.log limit 1");
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("delete from dev.log"), [3]);
    const writes = query.mock.calls.slice(2);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toContain("jsonb_to_recordset");
    expect(JSON.parse((writes[0]?.[1] as string[])[0]!)).toEqual([
      {
        logged_at: "1970-01-01T00:00:01.000Z", level: 50, message: "released id", request_id: "viewer-a",
        payload: { reqId: "viewer-a", level: 50, time: 1_000, msg: "released id" },
      },
      {
        logged_at: "1970-01-01T00:00:02.000Z", level: 40, message: "second id", request_id: "viewer-b",
        payload: { requestId: "viewer-b", level: 40, time: 2_000, msg: "second id" },
      },
    ]);
    expect(JSON.parse((writes[1]?.[1] as string[])[0]!)).toEqual([{
      logged_at: expect.any(String), level: 30, message: null, request_id: null,
      payload: { component: "standalone" },
    }]);
    expect(end).toHaveBeenCalledOnce();
  });

  it("persists arbitrary logger bindings without treating malformed URL and time fields as worker failures", async () => {
    const { query } = fakePool();
    const stream = await createPostgresTransport({ batchSize: 1 });
    const closed = once(stream, "close");
    const event = { req: { url: 42 }, time: 9e15, msg: "application binding" };

    try {
      stream.end(`${JSON.stringify(event)}\n`);
      await closed;
    } finally {
      stream.destroy();
    }

    expect(query).toHaveBeenCalledTimes(3);
    expect(JSON.parse((query.mock.calls[2]?.[1] as string[])[0]!)).toEqual([{
      logged_at: expect.any(String), level: 30, message: "application binding", request_id: null, payload: event,
    }]);
  });

  it("flushes a partial batch at its deadline even as additional events arrive", async () => {
    vi.useFakeTimers();
    const { query } = fakePool();
    const stream = await createPostgresTransport({ batchSize: 10, flushIntervalMs: 100 });
    const closed = once(stream, "close");

    try {
      stream.write('{"msg":"first"}\n');
      await vi.advanceTimersByTimeAsync(60);
      stream.write('{"msg":"second"}\n');
      await vi.advanceTimersByTimeAsync(40);
      expect(query).toHaveBeenCalledTimes(3);
      expect(JSON.parse((query.mock.calls[2]?.[1] as string[])[0]!)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.end();
      await closed;
    }
  });
});

it("reports a batch write error even after the pool closes cleanly", async () => {
  const { query, end } = fakePool();
  const stream = await createPostgresTransport({ batchSize: 1 });
  const error = new Error("write failed");
  query.mockRejectedValueOnce(error);
  const closed = once(stream, "close");

  try {
    stream.write('{"msg":"pending"}\n');
    await expect(closed).rejects.toBe(error);
    expect(end).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
  }
});

it("waits for the final asynchronous write before closing the pool", async () => {
  const { query, end } = fakePool();
  const stream = await createPostgresTransport({ batchSize: 10 });
  const writeStarted = Promise.withResolvers<void>();
  const write = Promise.withResolvers<{ rows: never[] }>();
  query.mockImplementationOnce(async () => {
    writeStarted.resolve();
    return write.promise;
  });
  const closed = once(stream, "close");

  try {
    stream.end('{"msg":"pending"}\n');
    await writeStarted.promise;
    expect(end).not.toHaveBeenCalled();
  } finally {
    write.resolve({ rows: [] });
    await closed;
  }
  expect(end).toHaveBeenCalledOnce();
});
