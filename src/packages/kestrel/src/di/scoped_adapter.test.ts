import { expect, it, vi } from "vitest";
import { createDependencyContainer } from "./container.js";
import { dep } from "./dependencies.js";
import { defineScopedAdapter, registerScopedAdapter } from "./adapter.js";

it("resolves each adapter against its execution's transaction context and disposes it once", async () => {
  const root = createDependencyContainer({});
  let sequence = 0;
  root.registerFactory("transactionContext", () => ({ id: ++sequence }), { lifetime: "scoped" });
  const dispose = vi.fn();
  const create = vi.fn(({ context }: { context: { id: number } }) => ({ context }));
  registerScopedAdapter(
    root,
    "storage",
    defineScopedAdapter({
      dependencies: { context: dep<{ id: number }>("transactionContext") },
      capabilities: {},
      create,
      dispose,
    }),
    undefined,
  );
  const first = root.createScope();
  const second = root.createScope();
  const storage = dep<{ context: { id: number } }>("storage");
  try {
    expect(create).not.toHaveBeenCalled();
    const a = first.resolve(storage);
    const b = second.resolve(storage);
    expect(a).toBe(first.resolve(storage));
    expect(a.context).toBe(first.resolve(dep("transactionContext")));
    expect(b.context).toBe(second.resolve(dep("transactionContext")));
    expect(a.context).not.toBe(b.context);
    expect(create).toHaveBeenCalledTimes(2);
    await first.dispose();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(a);
    expect(second.resolve(storage)).toBe(b);
    await second.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  } finally {
    await first.dispose();
    await second.dispose();
    await root.dispose();
  }
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("rejects asynchronous scoped initialization before registering or creating resources", async () => {
  const root = createDependencyContainer({});
  const create = vi.fn(() => ({}));
  try {
    expect(() =>
      registerScopedAdapter(
        root,
        "storage",
        {
          capabilities: {},
          create,
          // @ts-expect-error Scoped recipes cannot start implicit asynchronous initialization.
          initialize: async () => {},
        },
        undefined,
      ),
    ).toThrow("synchronously ready");
    expect(create).not.toHaveBeenCalled();
    expect(root.hasRegistration("storage")).toBe(false);
  } finally {
    await root.dispose();
  }
});
