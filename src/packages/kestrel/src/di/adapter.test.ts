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
      expect(a.get()).toBe(a.get());
      expect(a.get()).not.toBe(b.get());
      expect(b.get().label).toBe("b");
      expect(create).toHaveBeenCalledTimes(2);
      await a.dispose();
      expect(() => a.get()).toThrow("disposed");
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
    await registration.dispose();
    await container.dispose();
    expect(create).not.toHaveBeenCalled();
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
    expect(dispose).not.toHaveBeenCalled();
    complete();
    await boot;
    await closing;
    await container.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
