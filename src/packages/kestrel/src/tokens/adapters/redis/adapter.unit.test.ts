import { expect, it, vi } from "vitest";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { redisTokens } from "./definition.js";
import type { TokenStorageAdapter } from "../../types.js";

it("keeps token adapters scoped while borrowing the same native Redis client", async () => {
  const client = { eval: vi.fn(async () => null), destroy: vi.fn() };
  const connection = dep<typeof client>("redis");
  const container = createDependencyContainer({});
  const factory = vi.fn(() => client);
  container.registerFactory(connection.id, factory, { lifetime: "singleton" });
  registerScopedAdapter(container, "tokens", redisTokens(connection, { keyPrefix: "selected:" }), undefined);
  const first = container.createScope(), second = container.createScope();
  try {
    expect(factory).not.toHaveBeenCalled();
    const a = first.resolve(dep<TokenStorageAdapter>("tokens"));
    const b = second.resolve(dep<TokenStorageAdapter>("tokens"));
    expect(a).not.toBe(b);
    const input = { definition: "invitation", digest: Buffer.from("digest"), now: new Date() };
    await a.findValid(input);
    await b.findValid(input);
    expect(factory).toHaveBeenCalledOnce();
    expect(client.eval).toHaveBeenCalledTimes(2);
  } finally {
    await second.dispose(); await first.dispose(); await container.dispose();
  }
  expect(client.destroy).not.toHaveBeenCalled();
});
