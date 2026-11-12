import { once } from "node:events";

import { Pool, type PoolConfig } from "pg";
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

  it("reports startup and cleanup failures together", async () => {
    const { query, end } = fakePool();
    const startup = new Error("log table unavailable");
    const cleanup = new Error("pool shutdown failed");
    query.mockRejectedValueOnce(startup);
    end.mockRejectedValueOnce(cleanup);

    await expect(createPostgresTransport({})).rejects.toMatchObject({
      message: "PostgreSQL log transport startup and cleanup failed.",
      errors: [startup, cleanup],
    });
  });

  it.each([undefined, 7])("preserves connection options and the configured pool size (%s)", async (max) => {
    const { end } = fakePool();
    const settings: PoolConfig = { host: "log.example.test", database: "logging", ssl: true };
    const stream = await createPostgresTransport({ ...settings, ...(max === undefined ? {} : { max }) });
    const closed = once(stream, "close");

    stream.end();
    await closed;

    const pool = end.mock.contexts[0] as Pool & { options: PoolConfig };
    expect(pool.options).toMatchObject({ ...settings, max: max ?? 2 });
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

  it("skips only the viewer route path, preserving similarly named requests and query values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const { query } = fakePool();
    const stream = await createPostgresTransport({ batchSize: 10 });
    const closed = once(stream, "close");
    const viewerPath = "/studio/api/extensions/development-logs/logs";
    const log = (record: unknown) => stream.write(`${JSON.stringify(record)}\n`);

    try {
      log({ reqId: "viewer", req: { url: `${viewerPath}?limit=5` } });
      log({ reqId: "viewer", msg: "request completed" });
      log({ requestId: 9, req: { url: viewerPath } });
      log({ requestId: 9, msg: "numeric application binding" });
      log({ reqId: "different-path", req: { url: `${viewerPath}-export` } });
      log({ reqId: "different-path", msg: "request completed" });
      log({ reqId: "query-value", req: { url: `/search?next=${viewerPath}` } });
      log({ reqId: "query-value", msg: "request completed" });
      stream.end();
      await closed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.destroy();
    }

    const writes = query.mock.calls.slice(2);
    expect(writes).toHaveLength(1);
    expect(JSON.parse((writes[0]?.[1] as string[])[0]!)).toMatchObject([
      { request_id: null, message: "numeric application binding", logged_at: "2026-03-12T10:00:00.000Z" },
      { request_id: "different-path", message: null },
      { request_id: "different-path", message: "request completed" },
      { request_id: "query-value", message: null },
      { request_id: "query-value", message: "request completed" },
    ]);
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

  it("cancels the pending deadline when the batch fills", async () => {
    vi.useFakeTimers();
    const { query } = fakePool();
    const stream = await createPostgresTransport({ batchSize: 2, flushIntervalMs: 100 });
    const closed = once(stream, "close");

    try {
      stream.write('{"msg":"first"}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      stream.write('{"msg":"second"}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(3);
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

it("reports a write failure and a pool close failure together", async () => {
  const { query, end } = fakePool();
  const stream = await createPostgresTransport({ batchSize: 1 });
  const write = new Error("write failed");
  const cleanup = new Error("pool shutdown failed");
  query.mockRejectedValueOnce(write);
  end.mockRejectedValueOnce(cleanup);
  const closed = once(stream, "close");

  try {
    stream.write('{"msg":"pending"}\n');
    await expect(closed).rejects.toMatchObject({
      message: "PostgreSQL log transport and cleanup failed.",
      errors: [write, cleanup],
    });
  } finally {
    stream.destroy();
  }
});

it("surfaces the pool close error when the stream itself finished successfully", async () => {
  const { end } = fakePool();
  const stream = await createPostgresTransport({});
  const cleanup = new Error("pool shutdown failed");
  end.mockRejectedValueOnce(cleanup);
  const closed = once(stream, "close");

  try {
    stream.end();
    await expect(closed).rejects.toBe(cleanup);
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
