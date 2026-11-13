import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresPoolPolicyError, PostgresPoolRuntime } from "./pool_runtime.js";

const policy = { maxWaitingRequests: 1, shutdownTimeoutMs: 20 };

describe("PostgreSQL pool lifecycle", () => {
  it("releases admission when native client construction throws synchronously", async () => {
    // pg parses this connection string at checkout, before it can open a socket.
    const pool = new Pool({ max: 1, connectionString: "postgresql://[" });
    const runtime = new PostgresPoolRuntime(pool, { ...policy, maxWaitingRequests: 0 });
    const callback = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      expect(() => pool.connect(callback)).toThrow(TypeError);
      expect(callback).not.toHaveBeenCalled();
      expect(runtime.snapshot()).toMatchObject({
        state: "degraded", acquiring: 0, acquisitionFailures: 1,
        lastFailure: { type: "acquisition", failure: "acquisition_failed" },
      });

      // The next promise-form call still reaches pg and sees its native error.
      const second = pool.connect();
      expect(runtime.snapshot().acquiring).toBe(0);
      await expect(second).rejects.toBeInstanceOf(TypeError);
      expect(runtime.snapshot()).toMatchObject({ acquiring: 0, acquisitions: 2, acquisitionFailures: 2 });
    } finally {
      const closed = vi.fn();
      void runtime.close().then(() => closed(), closed);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toHaveBeenCalledExactlyOnceWith();
      } finally { vi.useRealTimers(); }
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("counts the granted lease before an acquisition sink can request another one", async () => {
    const pool = new Pool({ max: 1 });
    const client = new EventEmitter() as PoolClient;
    const release = vi.fn();
    const nativeConnect = vi.fn<(callback: Parameters<Pool["connect"]>[0]) => void>()
      .mockImplementation((callback) => callback(new Error("unexpected native checkout"), undefined, () => {}))
      .mockImplementationOnce((callback) => callback(undefined, client, release));
    pool.connect = nativeConnect as unknown as Pool["connect"];
    const reentrant = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, { ...policy, maxWaitingRequests: 0 }, (event) => {
      if (event.type === "acquisition" && event.outcome === "success") {
        // The sink runs synchronously and can reenter before connect returns.
        pool.connect(reentrant);
      }
    });

    try {
      const acquired = vi.fn();
      pool.connect(acquired);
      expect(acquired).toHaveBeenCalledExactlyOnceWith(undefined, client, client.release);
      // A full queue rejects asynchronously without entering the native driver.
      await Promise.resolve();
      expect(reentrant).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        code: "queue_full", name: "PostgresPoolPolicyError", message: "PostgreSQL pool policy: queue_full",
      }));
      expect(runtime.snapshot()).toMatchObject({
        state: "unknown", acquisitionFailures: 1,
        lastFailure: { type: "acquisition", failure: "queue_full" },
      });
      expect(nativeConnect).toHaveBeenCalledOnce();
    } finally {
      client.release?.();
      await runtime.close();
    }
  });

  it("preserves a synchronous checkout callback error after recording its acquisition", async () => {
    const pool = new Pool();
    const client = new EventEmitter() as PoolClient;
    const release = vi.fn();
    pool.connect = vi.fn((callback) => callback(undefined, client, release)) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const failure = new Error("application callback failed");

    try {
      expect(() => pool.connect((_error, _client, done) => {
        done();
        throw failure;
      })).toThrow(failure);
      expect(release).toHaveBeenCalledOnce();
      expect(runtime.snapshot()).toMatchObject({ acquiring: 0, acquisitions: 1, acquisitionFailures: 0 });
    } finally {
      await runtime.close();
    }
  });

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

  it("retains only supported error codes and gives consumers detached copies", async () => {
    const pool = new Pool();
    const onEvent = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    try {
      expect(runtime.snapshot()).toMatchObject({ state: "unknown", lastFailure: undefined });
      for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "57P01"]) {
        pool.emit("error", Object.assign(new Error("network error"), { code }));
        expect(runtime.snapshot().lastFailure).toMatchObject({ type: "pool_error", errorCode: code });
        expect(onEvent.mock.lastCall?.[0]).toMatchObject({ errorCode: code });
      }
      for (const code of ["57P01suffix", "prefix57P01", "private connection detail", 57_001]) {
        pool.emit("error", Object.assign(new Error("network error"), { code }));
        expect(runtime.snapshot().lastFailure?.errorCode).toBeUndefined();
      }
      // Mutating event and snapshot copies must leave the retained diagnostic intact.
      const event = onEvent.mock.lastCall?.[0];
      const snapshot = runtime.snapshot().lastFailure;
      expect(event).not.toBe(snapshot);
      Object.assign(event, { failure: "shutdown_timeout" });
      Object.assign(snapshot!, { failure: "shutdown_timeout" });
      expect(runtime.snapshot().lastFailure?.failure).toBe("pool_error");
    } finally {
      await runtime.close();
    }
  });

  it("never lets an error-code getter escape the pool boundary or mask a checkout failure", async () => {
    const pool = new Pool();
    const failure = Object.defineProperty(new Error("connection failed"), "code", {
      get() { throw new Error("code getter failed"); },
    });
    pool.connect = vi.fn((callback) => callback(failure)) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    try {
      expect(() => pool.emit("error", failure)).not.toThrow();
      await expect(pool.connect()).rejects.toBe(failure);
      expect(runtime.snapshot().lastFailure).toMatchObject({
        type: "acquisition", outcome: "failure", failure: "acquisition_failed", errorCode: undefined,
      });
    } finally {
      await runtime.close();
    }
  });

  it("contains synchronous observer throws and rejected observer promises", async () => {
    const pool = new Pool();
    const rejection = new Error("observer rejected");
    const rejectObservation = vi.fn((_resolve: (value: void) => void, reject: (error: Error) => void) => reject(rejection));
    // A thenable lets the test observe assimilation without leaking a native rejection under mutation.
    const observation = { then: rejectObservation } as unknown as Promise<void>;
    const onEvent = vi.fn()
      .mockImplementationOnce(() => { throw new Error("observer failed"); })
      .mockImplementationOnce(() => observation);
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    try {
      pool.emit("error", new Error("first driver failure"));
      pool.emit("error", new Error("second driver failure"));
      // Promise.resolve assimilates the returned observation on the next microtask.
      await Promise.resolve();
      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(rejectObservation).toHaveBeenCalledExactlyOnceWith(expect.any(Function), expect.any(Function));
      expect(runtime.snapshot().state).toBe("degraded");
    } finally { await runtime.close(); }
  });

  it("deduplicates a forwarded connection error and removes its listener when the connection ends", async () => {
    const pool = new Pool();
    const client = new EventEmitter();
    const onEvent = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    try {
      pool.emit("connect", client);
      const failure = new Error("idle connection lost");
      client.emit("error", failure);
      pool.emit("error", failure);
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: "pool_error", outcome: "failure", failure: "pool_error",
      }));
      client.emit("end");
      expect(client.listenerCount("error")).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("reports a reused Error object when a later failure invalidates a successful health check", async () => {
    const pool = new Pool();
    pool.query = vi.fn(async () => ({})) as unknown as Pool["query"];
    const onEvent = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    const failure = new Error("connection lost");

    try {
      pool.emit("error", failure);
      expect((await runtime.checkHealth()).state).toBe("healthy");
      pool.emit("error", failure);
      expect(runtime.snapshot().state).toBe("degraded");
      expect(onEvent).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });

  it("does not report recovery when two different failures invalidate the same check", async () => {
    const pool = new Pool();
    const health = Promise.withResolvers<unknown>();
    pool.query = vi.fn().mockReturnValueOnce(health.promise).mockRejectedValueOnce(new Error("probe failed")) as Pool["query"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    try {
      const checking = runtime.checkHealth();
      pool.emit("error", new Error("idle client failed"));
      await expect(runtime.checkHealth()).rejects.toThrow("probe failed");
      health.resolve({});
      expect((await checking).state).toBe("degraded");
    } finally {
      health.resolve({});
      await runtime.close();
    }
  });

  it("invalidates a pending health result after a native acquisition and idle-client failure", async () => {
    const pool = new Pool();
    const health = Promise.withResolvers<unknown>();
    const failure = new Error("checkout failed");
    pool.query = vi.fn(() => health.promise) as unknown as Pool["query"];
    pool.connect = vi.fn((callback) => callback(failure)) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    try {
      const checking = runtime.checkHealth();
      pool.emit("error", new Error("idle client failed"));
      await expect(pool.connect()).rejects.toBe(failure);
      health.resolve({});
      expect((await checking).state).toBe("degraded");
    } finally {
      health.resolve({});
      await runtime.close();
    }
  });

  it("preserves a native checkout error code when its construction throws synchronously", async () => {
    const pool = new Pool();
    const failure = Object.assign(new Error("construction failed"), { code: "ECONNRESET" });
    pool.connect = vi.fn(() => { throw failure; }) as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    try {
      expect(() => pool.connect(vi.fn())).toThrow(failure);
      expect(runtime.snapshot().lastFailure).toMatchObject({ errorCode: "ECONNRESET", failure: "acquisition_failed" });
    } finally {
      await runtime.close();
    }
  });

  it("reports the exact elapsed acquisition time and omits failure fields on success", async () => {
    const pool = new Pool();
    const client = new EventEmitter() as PoolClient;
    let finish!: Parameters<Pool["connect"]>[0];
    pool.connect = vi.fn((callback) => { finish = callback; }) as unknown as Pool["connect"];
    const onEvent = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    const clock = vi.spyOn(performance, "now").mockReturnValue(50);

    try {
      const checkout = pool.connect();
      clock.mockReturnValue(68);
      finish(undefined, client, vi.fn());
      await expect(checkout).resolves.toBe(client);
      expect(runtime.snapshot().lastAcquisitionDurationMs).toBe(18);
      expect(onEvent.mock.calls[0]?.[0]).toStrictEqual({
        type: "acquisition", outcome: "success", timestamp: expect.any(Number), durationMs: 18,
      });
    } finally {
      clock.mockRestore();
      client.release?.();
      await runtime.close();
    }
  });

  it("publishes successful shutdown, clears its timer and retains the last failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pool = new Pool();
      const onEvent = vi.fn();
      const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
      pool.emit("error", new Error("old failure"));
      const failure = runtime.snapshot().lastFailure;
      await runtime.close();
      expect(runtime.snapshot()).toMatchObject({ state: "closed", lastFailure: failure });
      expect(vi.getTimerCount()).toBe(0);
      expect(onEvent).toHaveBeenLastCalledWith({
        type: "shutdown", outcome: "success", timestamp: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps acquisition callbacks and late release safe during forced disposal", async () => {
    // A held client models application work that never returns its lease.
    const pool = new Pool({ max: 1 });
    const client = new EventEmitter() as PoolClient;
    Object.assign(client, { connection: { stream: new PassThrough() } });
    const release = vi.fn();
    pool.connect = vi.fn((callback) => callback(undefined, client, release)) as unknown as Pool["connect"];
    const nativeEnd = Promise.withResolvers<void>();
    pool.end = vi.fn(() => nativeEnd.promise) as Pool["end"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const acquired = vi.fn();
      pool.connect(acquired);
      expect(acquired).toHaveBeenCalledExactlyOnceWith(undefined, client, client.release);
      const close = runtime.close();
      const observeClose = vi.fn();
      void close.then(() => observeClose(), observeClose);
      expect(runtime.close()).toBe(close);
      await vi.advanceTimersByTimeAsync(policy.shutdownTimeoutMs);
      expect(observeClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "shutdown_timeout" }));
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
      expect(client.connection.stream.destroyed).toBe(true);
      client.release();
      expect(release).toHaveBeenCalledOnce();
      expect(runtime.snapshot().state).toBe("closed");
    } finally {
      nativeEnd.resolve();
      client.connection.stream.destroy();
      vi.useRealTimers();
    }
  });

  it("rejects pending acquisitions on close and evicts a late native connection", async () => {
    const pool = new Pool({ max: 1 });
    let complete!: (error: Error | undefined, client: PoolClient, release: PoolClient["release"]) => void;
    pool.connect = vi.fn((callback) => { complete = callback; }) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const rejected = vi.fn();
    pool.connect(rejected);
    await runtime.close();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "closing" }));
    const client = new EventEmitter() as PoolClient;
    const release = vi.fn();
    complete(undefined, client, release);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    const afterClose = vi.fn();
    pool.connect(afterClose);
    await Promise.resolve();
    expect(afterClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "closing" }));
  });

  it("preserves the single callback when the native checkout fails after closing", async () => {
    const pool = new Pool();
    let complete!: Parameters<Pool["connect"]>[0];
    pool.connect = vi.fn((callback) => { complete = callback; }) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const checkout = vi.fn();
    pool.connect(checkout);
    await runtime.close();
    // A queued native failure can follow Kestrel's synthetic close notification.
    expect(() => Reflect.apply(complete, undefined, [new Error("native checkout cancelled")])).not.toThrow();
    expect(checkout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "closing" }));
    expect(runtime.snapshot()).toMatchObject({ acquisitionFailures: 1, acquisitions: 1 });
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

  it("uses the client release method when native callbacks omit their release argument", async () => {
    const pool = new Pool({ max: 3 });
    const completions: Array<(error: undefined, client: PoolClient) => void> = [];
    pool.connect = vi.fn((callback) => { completions.push(callback); }) as unknown as Pool["connect"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const client = () => Object.assign(new EventEmitter(), { release: vi.fn() });
    const normal = client();
    const early = client();
    const late = client();
    const nativeRelease = normal.release;

    try {
      const active = pool.connect();
      completions[0]!(undefined, normal as unknown as PoolClient);
      (await active).release();
      expect(nativeRelease).toHaveBeenCalledOnce();

      // Both an immediate completion during close and a late completion must evict their client.
      const first = expect(pool.connect()).rejects.toMatchObject({ code: "closing" });
      const second = expect(pool.connect()).rejects.toMatchObject({ code: "closing" });
      const close = runtime.close();
      completions[1]!(undefined, early as unknown as PoolClient);
      await close;
      completions[2]!(undefined, late as unknown as PoolClient);
      await Promise.all([first, second]);
      expect(early.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(late.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { await runtime.close(); }
  });

  it("reports native shutdown failures and keeps late pool errors contained", async () => {
    const pool = new Pool();
    const failure = new Error("native shutdown failed");
    pool.end = vi.fn(async () => { throw failure; }) as Pool["end"];
    const onEvent = vi.fn();
    const runtime = new PostgresPoolRuntime(pool, policy, onEvent);
    const close = runtime.close();

    // A late pool error must not overwrite the closing state or crash without a subscriber.
    pool.emit("error", new Error("connection ended during close"));
    expect(runtime.snapshot().state).toBe("closing");
    await expect(close).rejects.toBe(failure);
    expect(runtime.snapshot()).toMatchObject({ state: "closed", lastFailure: { type: "shutdown", failure: "shutdown_failed" } });
    expect(onEvent.mock.calls.map(([event]) => event.failure)).toEqual(["pool_error", "shutdown_failed"]);
  });

  it("does not mark an acquisition as recovery and guards concurrent health failures", async () => {
    const pool = new Pool();
    const runtime = new PostgresPoolRuntime(pool, policy);
    let resolve!: () => void;
    pool.query = vi.fn(() => new Promise<void>((done) => { resolve = done; })) as unknown as Pool["query"];
    const checking = runtime.checkHealth();
    expect(pool.query).toHaveBeenCalledExactlyOnceWith("select 1");
    pool.emit("error", new Error("lost connection"));
    resolve();
    expect((await checking).state).toBe("degraded");
    pool.query = vi.fn(async () => ({})) as unknown as Pool["query"];
    expect((await runtime.checkHealth()).state).toBe("healthy");
    await runtime.close();
  });

  it("degrades on a failed health query while leaving policy rejection and recovery distinct", async () => {
    const pool = new Pool();
    const failure = new Error("health query failed");
    const saturated = new PostgresPoolPolicyError("queue_full");
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(saturated)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({});
    pool.query = query as Pool["query"];
    const runtime = new PostgresPoolRuntime(pool, policy);

    try {
      expect((await runtime.checkHealth()).state).toBe("healthy");
      await expect(runtime.checkHealth()).rejects.toBe(saturated);
      expect(runtime.snapshot().state).toBe("healthy");
      await expect(runtime.checkHealth()).rejects.toBe(failure);
      expect(runtime.snapshot().state).toBe("degraded");
      expect((await runtime.checkHealth()).state).toBe("healthy");
    } finally {
      await runtime.close();
    }
  });

  it("preserves a health query failure during shutdown without changing the closing state", async () => {
    const pool = new Pool();
    const query = Promise.withResolvers<unknown>();
    const drain = Promise.withResolvers<void>();
    pool.query = vi.fn(() => query.promise) as unknown as Pool["query"];
    pool.end = vi.fn(() => drain.promise) as Pool["end"];
    const runtime = new PostgresPoolRuntime(pool, policy);
    const failure = new Error("connection ended during the health query");
    const checking = runtime.checkHealth();
    const closing = runtime.close();

    try {
      query.reject(failure);
      await expect(checking).rejects.toBe(failure);
      expect(runtime.snapshot().state).toBe("closing");
    } finally {
      drain.resolve();
      await closing;
    }
    expect(runtime.snapshot().state).toBe("closed");
  });
});
