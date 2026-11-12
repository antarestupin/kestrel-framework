import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDependencyContainer, dep } from "./index.js";
import { defineAdapter, registerAdapter } from "./adapter.js";

/** Lifecycle coverage uses real containers but no network resources. */
describe("adapter definitions", () => {
  it("infers dependencies, stays lazy, and isolates a reusable definition per container", async () => {
    const connection = dep<{ label: string }>("connection");
    const create = vi.fn((label: string) => ({ label, close: vi.fn() }));
    const definition = defineAdapter({
      dependencies: { connection }, capabilities: {},
      create: ({ connection }) => {
        expectTypeOf(connection).toEqualTypeOf<{ label: string }>();
        return create(connection.label);
      },
      dispose: (value) => value.close(),
    });
    const first = createDependencyContainer({});
    const second = createDependencyContainer({});
    try {
      const a = registerAdapter(first, "adapter", definition, {});
      const b = registerAdapter(second, "adapter", definition, {});
      expect(create).not.toHaveBeenCalled();
      first.registerValue(connection.id, { label: "a" });
      second.registerValue(connection.id, { label: "b" });
      // Singleton consumers also require the public binding to have singleton lifetime.
      first.registerFactory("consumer", ({ adapter }: { adapter: { label: string } }) => ({ adapter }), { lifetime: "singleton" });
      expect(first.resolve(dep<{ adapter: { label: string } }>("consumer")).adapter).toBe(a.get());
      // Consumers resolving the public descriptor must share the handle's singleton.
      expect(first.resolve(dep("adapter"))).toBe(a.get());
      expect(second.resolve(dep("adapter"))).toBe(b.get());
      expect(first.resolve(dep("adapterRegistration"))).toBe(a);
      expect(a.get()).toBe(a.get());
      expect(a.get()).not.toBe(b.get());
      expect(b.get().label).toBe("b");
      expect(create).toHaveBeenCalledTimes(2);
      await a.dispose();
      expect(() => a.get()).toThrow("disposed");
      // A DI lookup must observe closure even when the adapter was resolved before disposal.
      expect(() => first.resolve(dep("adapter"))).toThrow("disposed");
      expect(second.resolve(dep("adapter"))).toBe(b.get());
    } finally { await first.dispose(); await second.dispose(); }
    for (const result of create.mock.results) expect(result.value.close).toHaveBeenCalledOnce();
  });

  it("initializes once and drains consumers before disposing owned resources", async () => {
    const order: string[] = [];
    const container = createDependencyContainer({});
    const initialize = vi.fn(async () => { order.push("initialize"); });
    const dispose = vi.fn(async () => { order.push("dispose"); });
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => ({}), initialize, dispose,
    }), {}, { beforeDispose: async () => { order.push("drain"); } });
    try {
      await Promise.all([registration.boot(), registration.boot()]);
      expect(initialize).toHaveBeenCalledOnce();
      await registration.dispose();
      await registration.dispose();
      expect(order).toEqual(["initialize", "drain", "dispose"]);
      // A cached successful boot must never make a disposed handle appear usable.
      await expect(registration.boot()).rejects.toThrow("disposed");
    } finally { await container.dispose(); }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["validation", "initialization"])("retains ownership after failed %s", async (failure) => {
    const container = createDependencyContainer({});
    const dispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => ({}), dispose,
      initialize: () => { if (failure === "initialization") throw new Error("rejected"); },
    }), {}, { validate: () => { if (failure === "validation") throw new Error("rejected"); } });
    try { await expect(registration.boot()).rejects.toThrow("rejected"); }
    finally { await container.dispose(); }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not construct unused adapters during disposal", async () => {
    const container = createDependencyContainer({});
    const create = vi.fn(() => ({}));
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create,
    }), {});
    try {
      await registration.dispose();
      // Disposing an unused handle must also prevent its first later activation.
      expect(() => registration.get()).toThrow("disposed");
      await expect(registration.boot()).rejects.toThrow("disposed");
    } finally { await container.dispose(); }
    expect(create).not.toHaveBeenCalled();
  });

  it("closes unused handles on container disposal without running adapter hooks", async () => {
    const container = createDependencyContainer({});
    const create = vi.fn(() => ({}));
    const initialize = vi.fn();
    const dispose = vi.fn();
    const beforeDispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create, initialize, dispose,
    }), undefined, { beforeDispose });
    await container.dispose();
    try {
      // The container owns the handle even if no consumer has initialized its adapter.
      expect(() => registration.get()).toThrow("disposed");
      await expect(registration.boot()).rejects.toThrow("disposed");
      expect(() => container.resolve(dep("adapter"))).toThrow("disposed");
      expect(create).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(beforeDispose).not.toHaveBeenCalled();
    } finally { await registration.dispose(); }
  });

  it("lends the same root adapter to synchronous and asynchronous singleton consumers", async () => {
    const root = createDependencyContainer({});
    const child = root.createScope();
    const endpoint = dep<string>("endpoint");
    const adapter = dep<{ endpoint: string }>("adapter");
    root.registerValue(endpoint.id, "root");
    child.registerValue(endpoint.id, "child");
    const registration = registerAdapter(root, adapter.id, defineAdapter({
      dependencies: { endpoint }, capabilities: {}, create: (dependencies) => dependencies,
    }), undefined);
    root.registerFactory("syncConsumer", ({ adapter }: { adapter: { endpoint: string } }) => adapter, { lifetime: "singleton" });
    root.registerAsyncFactory("asyncConsumer", { adapter }, ({ adapter }) => adapter, { lifetime: "singleton" });
    try {
      expect(child.resolve(dep("syncConsumer"))).toBe(registration.get());
      expect(await child.resolveAsync(dep("asyncConsumer"))).toBe(registration.get());
      expect(child.resolve(adapter)).toEqual({ endpoint: "root" });
      await registration.dispose();
      await expect(child.resolveAsync(adapter)).rejects.toThrow("disposed");
    } finally {
      await child.dispose();
      await root.dispose();
    }
  });

  it("copies nonempty capabilities into an immutable reusable recipe", () => {
    const capabilities = { transactions: true };
    const definition = defineAdapter({ dependencies: {}, capabilities, create: () => ({}) });
    capabilities.transactions = false;
    // Mutating caller-owned options must not change the published contract.
    expect(definition.capabilities).toEqual({ transactions: true });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.capabilities)).toBe(true);
    expect(Object.hasOwn(definition, "initialize")).toBe(false);
    expect(Object.hasOwn(definition, "dispose")).toBe(false);
  });

  it("cancels a queued boot without disposing an adapter that was never created", async () => {
    const container = createDependencyContainer({});
    const create = vi.fn(() => ({}));
    const initialize = vi.fn();
    const dispose = vi.fn();
    const beforeDispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create, initialize, dispose,
    }), {}, { beforeDispose });
    // Dispose before the boot microtask can acquire ownership of an instance.
    const boot = registration.boot();
    const rejectedBoot = expect(boot).rejects.toThrow("disposed");
    const closing = registration.dispose();
    try {
      await rejectedBoot;
      await closing;
      expect(create).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(beforeDispose).toHaveBeenCalledOnce();
    } finally { await container.dispose(); }
  });

  it("keeps differently named adapter lifecycles independent within one container", async () => {
    const container = createDependencyContainer({});
    const dispose = vi.fn();
    const definition = defineAdapter({
      dependencies: {}, capabilities: {}, create: (_dependencies, label: string) => ({ label }), dispose,
    });
    const first = registerAdapter(container, "first", definition, "first");
    const second = registerAdapter(container, "second", definition, "second");
    try {
      // Resolve after both registrations so a colliding lifecycle key cannot hide.
      expect(container.resolve(dep("first"))).toEqual({ label: "first" });
      expect(container.resolve(dep("second"))).toEqual({ label: "second" });
      expect(first.get()).not.toBe(second.get());
      await first.dispose();
      expect(second.get()).toEqual({ label: "second" });
    } finally { await container.dispose(); }
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("retains the original validation error across repeated access and boot", async () => {
    const container = createDependencyContainer({});
    const error = new Error("invalid backend");
    const value = {};
    const create = vi.fn(() => value);
    const validate = vi.fn(() => { throw error; });
    const initialize = vi.fn();
    const dispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create, initialize, dispose,
    }), {}, { validate });
    try {
      // A rejected instance remains owned but must never become usable on retry.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => registration.get()).toThrow(error);
        await expect(registration.boot()).rejects.toBe(error);
      }
      expect(create).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledExactlyOnceWith(value);
      expect(initialize).not.toHaveBeenCalled();
    } finally { await container.dispose(); }
    expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
  });

  it("supports adapters without optional initialization or disposal hooks", async () => {
    const container = createDependencyContainer({});
    const value = {};
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => value,
    }), {});
    try {
      await registration.boot();
      expect(registration.get()).toBe(value);
      await registration.dispose();
    } finally { await container.dispose(); }
  });

  it("rejects first DI resolution after disposal and releases resources even when draining fails", async () => {
    const container = createDependencyContainer({});
    const error = new Error("drain failed");
    const value = {};
    const dispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => value, dispose,
    }), {}, { beforeDispose: () => { throw error; } });
    try {
      registration.get();
      await expect(registration.dispose()).rejects.toBe(error);
      // The public factory has not been cached yet; it must reject a disposed resource.
      expect(() => container.resolve(dep("adapter"))).toThrow("disposed");
      await expect(registration.boot()).rejects.toThrow("disposed");
      expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
    } finally {
      // The container owns the same cached failed disposal promise.
      await expect(container.dispose()).rejects.toThrow();
    }
  });

  it("keeps both the drain error and the release error", async () => {
    const container = createDependencyContainer({});
    const drainFailure = new Error("drain failed");
    const releaseFailure = new Error("release failed");
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => ({}),
      dispose: () => { throw releaseFailure; },
    }), undefined, { beforeDispose: () => { throw drainFailure; } });
    registration.get();
    try {
      const failure = await registration.dispose().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toBe('Adapter "adapter" disposal failed.');
      expect((failure as AggregateError).errors).toEqual([drainFailure, releaseFailure]);
    } finally { await container.dispose().catch(() => {}); }
  });

  it("waits for in-flight initialization before disposing", async () => {
    const container = createDependencyContainer({});
    let complete!: () => void;
    const dispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create: () => ({}), dispose,
      initialize: () => new Promise<void>((resolve) => { complete = resolve; }),
    }), {});
    const boot = registration.boot();
    await Promise.resolve();
    const closing = registration.dispose();
    try {
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      complete();
      await boot;
      await closing;
      await container.dispose();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes the public handle when the container starts disposing its adapter", async () => {
    const container = createDependencyContainer({});
    const enteredDrain = Promise.withResolvers<void>();
    const finishDrain = Promise.withResolvers<void>();
    const create = vi.fn(() => ({}));
    const dispose = vi.fn();
    const registration = registerAdapter(container, "adapter", defineAdapter({
      dependencies: {}, capabilities: {}, create, dispose,
    }), {}, { beforeDispose: () => { enteredDrain.resolve(); return finishDrain.promise; } });
    await registration.boot();
    const closing = container.dispose();
    try {
      await enteredDrain.promise;
      // Container disposal clears its DI cache before awaiting resource cleanup.
      // Neither the handle nor a fresh public resolution may recreate infrastructure.
      expect(() => registration.get()).toThrow("disposed");
      await expect(registration.boot()).rejects.toThrow("disposed");
      expect(() => container.resolve(dep("adapter"))).toThrow("disposed");
      finishDrain.resolve();
      await closing;
      expect(() => registration.get()).toThrow("disposed");
      await expect(registration.boot()).rejects.toThrow("disposed");
      expect(create).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      finishDrain.resolve();
      await closing;
      // Also clean up an instance resurrected by a failing implementation or mutant.
      await registration.dispose();
    }
  });
});
