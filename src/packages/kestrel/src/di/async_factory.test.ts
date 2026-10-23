import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createDependencyContainer, dep, fromConfig } from "./index.js";

/** Explicit gates make concurrency assertions independent of timer scheduling. */
function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("asynchronous dependencies", () => {
  it("awaits a transitive graph before constructing services and preserves inference", async () => {
    const container = createDependencyContainer({ prefix: "Hello" });
    const loaded = gate<{ name: string }>();
    class Greeting {
      public constructor(public readonly user: { name: string }, public readonly prefix: string) {}
    }
    const construct = vi.fn(({ user, prefix }) => new Greeting(user, prefix));
    container.registerAsyncFactory("user", {}, () => loaded.promise, { lifetime: "scoped" });
    container.registerAsyncFactory("greeting", {
      user: dep<{ name: string }>("user"),
      prefix: fromConfig((config: { prefix: string }) => config.prefix),
    }, construct, { lifetime: "scoped" });
    try {
      const result = container.resolveDependenciesAsync({ greeting: dep<Greeting>("greeting") });
      await Promise.resolve();
      expect(construct).not.toHaveBeenCalled();
      loaded.resolve({ name: "Ada" });
      const { greeting } = await result;
      expect(greeting).toBeInstanceOf(Greeting);
      expect(greeting.user.name).toBe("Ada");
      expect(greeting.prefix).toBe("Hello");
      expectTypeOf(greeting).toEqualTypeOf<Greeting>();
    } finally {
      loaded.resolve({ name: "Ada" });
      await container.dispose();
    }
  });

  it("shares in-flight scoped work, isolates overrides and keeps singletons at the root", async () => {
    const container = createDependencyContainer({});
    const first = container.createScope();
    const second = first.createScope();
    const create = vi.fn(async ({ label }: { label: string }) => ({ label }));
    container.registerValue("label", "root");
    first.registerValue("label", "first");
    second.registerValue("label", "second");
    for (const lifetime of ["singleton", "scoped", "transient"] as const) {
      container.registerAsyncFactory(lifetime, { label: dep<string>("label") }, create, { lifetime });
    }
    try {
      const token = dep<{ label: string }>("scoped");
      const [left, right] = await Promise.all([first.resolveAsync(token), first.resolveAsync(token)]);
      expect(left).toBe(right);
      expect(left.label).toBe("first");
      const other = await second.resolveAsync(token);
      expect(other).not.toBe(left);
      expect(other.label).toBe("second");
      const singleton = await second.resolveAsync(dep<{ label: string }>("singleton"));
      expect(singleton.label).toBe("root");
      expect(await first.resolveAsync(dep("singleton"))).toBe(singleton);
      expect(await container.resolveAsync(dep("singleton"))).toBe(singleton);
      expect(await first.resolveAsync(dep("transient"))).not.toBe(await first.resolveAsync(dep("transient")));
      second.registerValue("scoped", "override");
      expect(await second.resolveAsync(dep("scoped"))).toBe("override");
    } finally {
      await second.dispose();
      await first.dispose();
      await container.dispose();
    }
  });

  it("rejects sync access without running the async factory, including implicit consumers", async () => {
    const container = createDependencyContainer({});
    const create = vi.fn(async () => ({}));
    container.registerAsyncFactory("user", {}, create, { lifetime: "scoped" });
    container.registerFactory("service", ({ user }: { user: object }) => ({ user }), { lifetime: "scoped" });
    try {
      expect(() => container.resolve(dep("user"))).toThrow(/resolveAsync/);
      await expect(container.resolveAsync(dep("service"))).rejects.toThrow(/registerAsyncFactory/);
      expect(create).not.toHaveBeenCalled();
      await container.resolveAsync(dep("user"));
      expect(() => container.resolve(dep("user"))).toThrow(/resolveAsync/);
      expect(create).toHaveBeenCalledOnce();
    } finally {
      await container.dispose();
    }
  });

  it("memoizes scoped failures and never calls a consumer factory after dependency failure", async () => {
    const container = createDependencyContainer({});
    const failure = new Error("Lookup failed");
    const create = vi.fn(async () => { throw failure; });
    const consume = vi.fn();
    const dispose = vi.fn();
    container.registerAsyncFactory("user", {}, create, { lifetime: "scoped", dispose });
    container.registerAsyncFactory("consumer", { user: dep("user") }, consume, { lifetime: "scoped" });
    try {
      const results = await Promise.allSettled([
        container.resolveAsync(dep("user")), container.resolveAsync(dep("consumer")),
      ]);
      expect(results).toEqual([
        { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
      ]);
      await expect(container.resolveAsync(dep("user"))).rejects.toBe(failure);
      expect(create).toHaveBeenCalledOnce();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await container.dispose();
    }
    expect(dispose).not.toHaveBeenCalled();
  });

  it("detects cycles before concurrent entry points can deadlock", async () => {
    const container = createDependencyContainer({});
    const create = vi.fn(() => ({}));
    container.registerAsyncFactory("a", { b: dep("b") }, create, { lifetime: "scoped" });
    container.registerAsyncFactory("b", { a: dep("a") }, create, { lifetime: "scoped" });
    try {
      const results = await Promise.allSettled([container.resolveAsync(dep("a")), container.resolveAsync(dep("b"))]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.message).toMatch(/Cyclic asynchronous dependencies/);
      }
      expect(create).not.toHaveBeenCalled();
    } finally {
      await container.dispose();
    }
  });

  it.each(["async", "sync"])("rejects shorter-lived %s prerequisites even when already cached", async (kind) => {
    const container = createDependencyContainer({});
    if (kind === "async") container.registerAsyncFactory("scoped", {}, async () => ({}), { lifetime: "scoped" });
    else container.registerFactory("scoped", () => ({}), { lifetime: "scoped" });
    container.registerAsyncFactory("singleton", { scoped: dep("scoped") }, () => ({}), { lifetime: "singleton" });
    try {
      await container.resolveAsync(dep("scoped"));
      await expect(container.resolveAsync(dep("singleton"))).rejects.toThrow(/shorter lifetime/);
      const scope = container.createScope();
      try {
        expect(() => scope.registerAsyncFactory("illegal", {}, () => ({}), { lifetime: "singleton" })).toThrow(/singleton/);
      } finally { await scope.dispose(); }
    } finally {
      await container.dispose();
    }
  });

  it("drains initialization before disposing consumers, async prerequisites and sync resources", async () => {
    const container = createDependencyContainer({});
    const started = gate<void>();
    const finish = gate<void>();
    const events: string[] = [];
    container.registerFactory("sync", () => ({}), { lifetime: "scoped", dispose: () => { events.push("sync"); } });
    container.registerAsyncFactory("dependency", { sync: dep("sync") }, async () => {
      started.resolve();
      await finish.promise;
      return {};
    }, { lifetime: "scoped", dispose: () => { events.push("dependency"); } });
    container.registerAsyncFactory("consumer", { dependency: dep("dependency") }, () => ({}), {
      lifetime: "scoped", dispose: () => { events.push("consumer"); },
    });
    const result = container.resolveAsync(dep("consumer"));
    await started.promise;
    const disposal = container.dispose();
    expect(container.dispose()).toBe(disposal);
    await expect(container.resolveAsync(dep("consumer"))).rejects.toThrow(/disposing or disposed/);
    expect(events).toEqual([]);
    finish.resolve();
    await result;
    await disposal;
    expect(events).toEqual(["consumer", "dependency", "sync"]);
  });

  it("cleans up owned transient instances and continues cleanup after a disposer fails", async () => {
    const container = createDependencyContainer({});
    const disposeSync = vi.fn();
    const disposeAsync = vi.fn(() => { throw new Error("Cleanup failed"); });
    const unused = vi.fn();
    container.registerValue("sync", {}, { dispose: disposeSync });
    container.registerAsyncFactory("unused", {}, unused);
    container.registerAsyncFactory("resource", {}, async () => ({}), { dispose: disposeAsync });
    await Promise.all([container.resolveAsync(dep("resource")), container.resolveAsync(dep("resource"))]);
    await expect(container.dispose()).rejects.toThrow(/Dependency disposal failed/);
    expect(disposeAsync).toHaveBeenCalledTimes(2);
    expect(disposeSync).toHaveBeenCalledOnce();
    expect(unused).not.toHaveBeenCalled();
  });

  it("awaits sibling initialization before propagating a resolution failure", async () => {
    const container = createDependencyContainer({});
    const finish = gate<void>();
    const started = gate<void>();
    const failure = new Error("Unavailable");
    let settled = false;
    container.registerAsyncFactory("slow", {}, async () => {
      started.resolve();
      await finish.promise;
      return {};
    });
    container.registerAsyncFactory("failed", {}, async () => { throw failure; });
    try {
      const result = container.resolveDependenciesAsync({ failed: dep("failed"), slow: dep("slow") });
      void result.then(() => { settled = true; }, () => { settled = true; });
      await started.promise;
      expect(settled).toBe(false);
      finish.resolve();
      await expect(result).rejects.toBe(failure);
    } finally {
      finish.resolve();
      await container.dispose();
    }
  });
});
