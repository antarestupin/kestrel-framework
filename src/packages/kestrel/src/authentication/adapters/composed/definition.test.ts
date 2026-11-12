import { expect, it, vi } from "vitest";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { defineAuthenticationAdapter, defineSessionStorageAdapter } from "../../adapter_definition.js";
import { MemoryAuthenticationAdapter } from "../memory/adapter.js";
import { withAuthenticationSessions } from "./definition.js";
import type { AuthenticationAdapter } from "../../stores.js";

it.each(["account", "session"])("rejects an asynchronous %s adapter before creating either child", (child) => {
  const create = vi.fn(() => new MemoryAuthenticationAdapter());
  const initialize = vi.fn(async () => {});
  const base = defineAuthenticationAdapter({
    dependencies: {},
    capabilities: {},
    create,
  });
  const sessions = defineSessionStorageAdapter({
    dependencies: {},
    capabilities: {},
    create,
  });

  // Simulate an external JavaScript adapter that bypasses the scoped TypeScript contract.
  expect(() => Reflect.apply(withAuthenticationSessions, undefined, [
    child === "account" ? { ...base, initialize } : base,
    child === "session" ? { ...sessions, initialize } : sessions,
  ]))
    .toThrow("Scoped authentication adapters must be synchronously ready");
  expect(create).not.toHaveBeenCalled();
  expect(initialize).not.toHaveBeenCalled();
});

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

it("routes security-version changes to the base and session mutations to the session store", async () => {
  const base = new MemoryAuthenticationAdapter();
  const sessions = new MemoryAuthenticationAdapter();
  const recipe = withAuthenticationSessions(
    defineAuthenticationAdapter({ dependencies: {}, capabilities: {}, create: () => base }),
    defineSessionStorageAdapter({ dependencies: {}, capabilities: {}, create: () => sessions }),
  );
  const adapter = recipe.create(() => { throw new Error("No dependencies expected."); }, undefined);
  try {
    const account = await adapter.createAccount({ subjectId: "subject" });
    expect(await adapter.incrementSecurityVersion(account.id)).toBe(account.securityVersion + 1);
    expect(await base.findById(account.id)).toMatchObject({ securityVersion: account.securityVersion + 1 });
    const start = new Date("2026-01-01T00:00:00.000Z");
    const session = await adapter.createSession({
      id: "session", accountId: account.id, tokenDigest: new Uint8Array([1]),
      claims: {}, accountSecurityVersion: account.securityVersion + 1,
      evidence: { method: "password", factors: ["knowledge"], authenticatedAt: start },
      createdAt: start, lastSeenAt: start,
      idleExpiresAt: new Date(start.getTime() + 10_000),
      absoluteExpiresAt: new Date(start.getTime() + 60_000),
    });
    const now = new Date(start.getTime() + 1_000);
    const idleExpiresAt = new Date(start.getTime() + 11_000);

    // Inspect both children to verify that touch and account-wide revocation reach the session owner.
    expect(await adapter.touch({ id: session.id, now, lastSeenAt: now, idleExpiresAt }))
      .toMatchObject({ lastSeenAt: now, idleExpiresAt });
    expect(await adapter.revokeAllForAccount({ accountId: account.id, revokedAt: now, reason: "logout" }))
      .toBe(1);
    expect(await sessions.findByTokenDigest(session.tokenDigest)).toMatchObject({
      lastSeenAt: now, idleExpiresAt, revokedAt: now, revokeReason: "logout",
    });
    expect(await base.listForAccount(account.id)).toEqual([]);
  } finally {
    await recipe.dispose!(adapter);
  }
});
