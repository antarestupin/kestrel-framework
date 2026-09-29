import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DeferredTasks,
  DeferredTasksClosedError,
} from "./index.js";

describe("DeferredTasks", () => {
  it("registers deferred work before running it in a microtask", async () => {
    const tasks = new DeferredTasks();
    const task = vi.fn();

    tasks.defer(task);

    expect(tasks.pendingCount).toBe(1);
    expect(task).not.toHaveBeenCalled();

    await tasks.wait();

    expect(task).toHaveBeenCalledOnce();
    expect(tasks.pendingCount).toBe(0);
    expect(tasks.state).toBe("open");
  });

  it("tracks an existing promise while preserving its result", async () => {
    const tasks = new DeferredTasks();
    let resolvePromise = (_value: number): void => undefined;
    const promise = new Promise<number>((resolve) => {
      resolvePromise = resolve;
    });

    const tracked = tasks.track(promise);

    expect(tasks.pendingCount).toBe(1);
    resolvePromise(42);

    await expect(tracked).resolves.toBe(42);
    await expect(tasks.wait()).resolves.toBeUndefined();
  });

  it("waits for tasks registered by pending work", async () => {
    const tasks = new DeferredTasks();
    const calls: string[] = [];
    let releaseParent = (): void => undefined;
    const parentBlocked = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });

    tasks.defer(async () => {
      calls.push("parent:start");
      await parentBlocked;
      tasks.defer(() => {
        calls.push("child");
      });
      calls.push("parent:end");
    });

    const idle = tasks.wait();
    await vi.waitFor(() => expect(calls).toEqual(["parent:start"]));
    releaseParent();
    await idle;

    expect(calls).toEqual(["parent:start", "parent:end", "child"]);
  });

  it("can wait for several independent work cycles", async () => {
    const tasks = new DeferredTasks();
    const calls: number[] = [];

    tasks.defer(() => calls.push(1));
    await tasks.wait();

    tasks.defer(() => calls.push(2));
    await tasks.wait();

    expect(calls).toEqual([1, 2]);
    expect(tasks.state).toBe("open");
  });

  it("propagates one task error directly and consumes it at the boundary", async () => {
    const tasks = new DeferredTasks();
    const failure = new Error("failed");

    tasks.defer(() => {
      throw failure;
    });

    await expect(tasks.wait()).rejects.toBe(failure);
    await expect(tasks.wait()).resolves.toBeUndefined();
  });

  it("aggregates several errors after all tasks settle", async () => {
    const tasks = new DeferredTasks();
    const firstFailure = new Error("first");
    const secondFailure = new Error("second");
    const completed = vi.fn();

    tasks.defer(() => {
      throw firstFailure;
    });
    tasks.defer(async () => {
      await Promise.resolve();
      completed();
      throw secondFailure;
    });

    const rejection = await tasks.wait().catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ]);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("gives concurrent waiters the same failure result", async () => {
    const tasks = new DeferredTasks();
    const failure = new Error("failed");

    tasks.defer(() => {
      throw failure;
    });

    const firstWait = tasks.wait();
    const secondWait = tasks.wait();

    await expect(firstWait).rejects.toBe(failure);
    await expect(secondWait).rejects.toBe(failure);
  });

  it("reports failures immediately and contains reporter failures", async () => {
    const failure = new Error("task failed");
    const report = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const tasks = new DeferredTasks({ onError: report });

    tasks.defer(
      () => {
        throw failure;
      },
      { name: "email.send" },
    );

    await expect(tasks.wait()).rejects.toBe(failure);
    expect(report).toHaveBeenCalledWith(failure, {
      name: "email.send",
    });
  });

  it("accepts child work while closing and closes at quiescence", async () => {
    const tasks = new DeferredTasks();
    const child = vi.fn();
    let releaseParent = (): void => undefined;
    const parentBlocked = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });

    tasks.defer(async () => {
      await parentBlocked;
      tasks.defer(child);
    });

    const closing = tasks.close();

    expect(tasks.state).toBe("closing");
    releaseParent();
    await closing;

    expect(child).toHaveBeenCalledOnce();
    expect(tasks.pendingCount).toBe(0);
    expect(tasks.state).toBe("closed");
    expect(() => tasks.defer(() => undefined)).toThrow(
      DeferredTasksClosedError,
    );
  });

  it("closes an idle group synchronously and shares repeated close calls", async () => {
    const tasks = new DeferredTasks();

    const firstClose = tasks.close();
    const secondClose = tasks.close();

    expect(tasks.state).toBe("closed");
    expect(secondClose).toBe(firstClose);
    expect(() => tasks.track(Promise.resolve())).toThrow(
      DeferredTasksClosedError,
    );
    await expect(firstClose).resolves.toBeUndefined();
  });

  it("closes even when deferred work fails", async () => {
    const tasks = new DeferredTasks();
    const failure = new Error("failed");

    tasks.defer(() => {
      throw failure;
    });

    await expect(tasks.close()).rejects.toBe(failure);
    expect(tasks.state).toBe("closed");
  });
});
