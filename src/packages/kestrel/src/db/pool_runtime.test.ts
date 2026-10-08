import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresPoolRuntime } from "./pool_runtime.js";

const policy = { maxWaitingRequests: 1, shutdownTimeoutMs: 20 };

describe("PostgreSQL pool lifecycle", () => {
  it("handles pool errors without a subscriber and does not report secrets", async () => {
    const pool = new Pool();
    const onEvent = vi.fn(() => Promise.reject(new Error("sink failed")));
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    const error = Object.assign(new Error("password=secret sql=private"), { code: "57P01" });
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(runtime.snapshot().state).toBe("degraded");
    expect(runtime.snapshot().lastFailure?.errorCode).toBe("57P01");
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("secret");
    await runtime.close();
  });

  it("keeps acquisition callbacks and late release safe during forced disposal", async () => {
    // A held client models application work that never returns its lease.
    const pool = new Pool({ max: 1 });
    const client = new EventEmitter() as PoolClient;
    Object.assign(client, { connection: { stream: new PassThrough() } });
    const release = vi.fn();
    pool.connect = vi.fn((callback) => callback(undefined, client, release)) as unknown as Pool["connect"];
    pool.end = vi.fn(() => new Promise<void>(() => {})) as Pool["end"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    await new Promise<void>((resolve, reject) => pool.connect((error, acquired, done) => {
      if (error) return reject(error);
      expect(acquired).toBe(client);
      expect(done).toBe(client.release);
      resolve();
    }));
    const close = runtime.close();
    expect(runtime.close()).toBe(close);
    await expect(close).rejects.toMatchObject({ code: "shutdown_timeout" });
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    client.release();
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.snapshot().state).toBe("closed");
  });

  it("rejects pending acquisitions on close and evicts a late native connection", async () => {
    const pool = new Pool({ max: 1 });
    let complete!: (error: Error | undefined, client: PoolClient, release: PoolClient["release"]) => void;
    pool.connect = vi.fn((callback) => { complete = callback; }) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const pending = pool.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: "closing" });
    await runtime.close();
    await rejected;
    const client = new EventEmitter() as PoolClient;
    const release = vi.fn();
    complete(undefined, client, release);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(pool.connect()).rejects.toMatchObject({ code: "closing" });
  });

  it("rejects a connection completing between close admission and native drain", async () => {
    const pool = new Pool({ max: 1 });
    let complete!: (error: Error | undefined, client: PoolClient, release: PoolClient["release"]) => void;
    pool.connect = vi.fn((callback) => { complete = callback; }) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const pending = pool.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: "closing" });
    const close = runtime.close();
    const release = vi.fn();
    complete(undefined, new EventEmitter() as PoolClient, release);
    await close;
    await rejected;
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not mark an acquisition as recovery and guards concurrent health failures", async () => {
    const pool = new Pool();
    const runtime = new PostgresPoolRuntime(pool, policy);
    let resolve!: () => void;
    pool.query = vi.fn(() => new Promise<void>((done) => { resolve = done; })) as unknown as Pool["query"];
    const checking = runtime.checkHealth();
    pool.emit("error", new Error("lost connection"));
    resolve();
    expect((await checking).state).toBe("degraded");
    pool.query = vi.fn(async () => ({})) as unknown as Pool["query"];
    expect((await runtime.checkHealth()).state).toBe("healthy");
    await runtime.close();
  });
});
