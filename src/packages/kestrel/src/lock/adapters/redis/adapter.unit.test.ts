import type { RedisClientType } from "@redis/client";
import { expect, it, vi } from "vitest";
import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { lockConfigBase } from "../../configuration.js";
import { LockProvider } from "../../provider.js";
import { locksDependency } from "../../dependencies.js";
import { RedisLockAdapter } from "./adapter.js";
import { redisLocks } from "./definition.js";

it("selects a borrowed native client lazily and never registers Redis pruning", async () => {
  const client = { eval: vi.fn(async (_script: string, _options: unknown) => null), destroy: vi.fn() };
  const connection = dep<typeof client>("dedicatedRedis");
  const resolve = vi.fn(() => client);
  const settings = { keyPrefix: "first:" };
  const app = new App({});
  app.container.registerFactory(connection.id, resolve, { lifetime: "singleton" });
  app.register(new LockProvider(lockConfigBase.schema.parse({ namespace: "test" }), redisLocks(connection, settings)));
  app.prepareBootPlan([], "minimal");
  try {
    await app.start();
    expect(resolve).not.toHaveBeenCalled();
    settings.keyPrefix = "selected:";
    await expect(app.container.resolve(locksDependency).tryAcquire("key")).resolves.toBeUndefined();
    expect(client.eval.mock.calls[0]![1]).toMatchObject({ keys: ["selected:{locks}:sequence", expect.stringContaining("selected:{locks}:lease:")] });
    expect(JSON.stringify(app.catalog.scheduledTasks)).not.toContain("maintenance.lock-prune");
  } finally { await app.dispose(); }
  expect(client.destroy).not.toHaveBeenCalled();
});

it("rejects an empty prefix before constructing physical lease keys", () => {
  const evalScript = vi.fn<RedisClientType["eval"]>();
  expect(() => new RedisLockAdapter({ eval: evalScript }, { keyPrefix: "" }))
    .toThrow("Redis lock key prefixes cannot be empty");
  expect(evalScript).not.toHaveBeenCalled();
});

it("rejects invalid Redis replies without interpreting them as contention or lost ownership", async () => {
  const evalScript = vi.fn<RedisClientType["eval"]>()
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(1);
  const adapter = new RedisLockAdapter({ eval: evalScript });
  const request = { key: "resource", ownerId: "owner", ttlMs: 1_000 };

  await expect(adapter.release(request)).rejects.toThrow("Invalid Redis lock release result");
  await expect(adapter.tryAcquire(request)).rejects.toThrow("Invalid Redis lock batch result");
});

it.each([{ ownerId: "another-owner" }, { key: "another-key" }])("rejects a lease for a different identity ($key $ownerId)", async (changed) => {
  const request = { key: "resource", ownerId: "owner", ttlMs: 1_000 };
  const lease = { version: 1, key: request.key, ownerId: request.ownerId, expiresAt: "1234", fencingToken: "3" };
  const evalScript = vi.fn<RedisClientType["eval"]>()
    .mockResolvedValueOnce(JSON.stringify([{ ...lease, ...changed }]))
    .mockResolvedValueOnce(JSON.stringify([lease]));
  const adapter = new RedisLockAdapter({ eval: evalScript });

  // A structurally valid reply for a different lock must fail before publishing ownership.
  await expect(adapter.tryAcquire(request)).rejects.toThrow("Redis returned a different lock owner or key");
  await expect(adapter.tryAcquire(request)).resolves.toEqual({
    key: "resource", ownerId: "owner", expiresAt: new Date(1234), fencingToken: 3n,
  });
});
