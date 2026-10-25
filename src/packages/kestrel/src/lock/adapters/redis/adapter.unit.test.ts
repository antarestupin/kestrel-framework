import { expect, it, vi } from "vitest";
import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { lockConfigBase } from "../../configuration.js";
import { LockProvider } from "../../provider.js";
import { locksDependency } from "../../dependencies.js";
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
