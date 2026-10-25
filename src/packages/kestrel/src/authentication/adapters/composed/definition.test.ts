import { expect, it, vi } from "vitest";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { defineAuthenticationAdapter, defineSessionStorageAdapter } from "../../adapter_definition.js";
import { MemoryAuthenticationAdapter } from "../memory/adapter.js";
import { withAuthenticationSessions } from "./definition.js";
import type { AuthenticationAdapter } from "../../stores.js";

it("composes external definitions per scope and disposes each created child once", async () => {
  const base = new MemoryAuthenticationAdapter();
  const sessions = new MemoryAuthenticationAdapter();
  const baseCreate = vi.fn(() => base), sessionCreate = vi.fn(() => sessions);
  const baseDispose = vi.fn(), sessionDispose = vi.fn();
  const recipe = withAuthenticationSessions(
    defineAuthenticationAdapter({ dependencies: {}, capabilities: {}, create: baseCreate, dispose: baseDispose }),
    defineSessionStorageAdapter({ dependencies: {}, capabilities: {}, create: sessionCreate, dispose: sessionDispose }),
  );
  const container = createDependencyContainer({});
  registerScopedAdapter(container, "authentication", recipe, undefined);
  const first = container.createScope(), second = container.createScope();
  try {
    const a = first.resolve(dep<AuthenticationAdapter>("authentication"));
    const b = second.resolve(dep<AuthenticationAdapter>("authentication"));
    expect(a).not.toBe(b);
    expect(baseCreate).not.toHaveBeenCalled();
    await a.createAccount({ subjectId: "user" });
    expect(baseCreate).toHaveBeenCalledOnce();
    expect(sessionCreate).not.toHaveBeenCalled();
    await a.listForAccount("account");
    expect(sessionCreate).toHaveBeenCalledOnce();
    await first.dispose();
    expect(baseDispose).toHaveBeenCalledExactlyOnceWith(base);
    expect(sessionDispose).toHaveBeenCalledExactlyOnceWith(sessions);
    await second.dispose();
    expect(baseDispose).toHaveBeenCalledOnce();
    expect(sessionDispose).toHaveBeenCalledOnce();
  } finally { await second.dispose(); await first.dispose(); await container.dispose(); }
});

it("retains cleanup ownership when a child fails to construct or dispose", async () => {
  const base = new MemoryAuthenticationAdapter();
  const dispose = vi.fn(async () => { throw new Error("cleanup failed"); });
  const recipe = withAuthenticationSessions(
    defineAuthenticationAdapter({ dependencies: {}, capabilities: {}, create: () => base, dispose }),
    defineSessionStorageAdapter({ dependencies: {}, capabilities: {}, create: () => { throw new Error("session construction failed"); } }),
  );
  const adapter = recipe.create(() => { throw new Error("No dependencies expected."); }, undefined);
  await adapter.findById("missing");
  expect(() => adapter.listForAccount("account")).toThrow("session construction failed");
  await expect(recipe.dispose!(adapter)).rejects.toThrow("cleanup failed");
  await recipe.dispose!(adapter);
  expect(dispose).toHaveBeenCalledOnce();
});
