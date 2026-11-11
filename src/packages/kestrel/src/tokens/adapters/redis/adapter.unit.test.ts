import type { RedisClientType } from "@redis/client";
import { expect, it, vi } from "vitest";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { RedisTokenStorageAdapter } from "./adapter.js";
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

it("rejects token lookup replies that do not match the requested identity", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const digest = Buffer.from("requested-token");
  const stored = {
    version: 1,
    id: "token-1",
    definition: "invitation",
    digest: digest.toString("base64url"),
    createdAt: now.getTime(),
    expiresAt: now.getTime() + 60_000,
    payload: JSON.stringify({ privileged: true }),
  };
  const client = { eval: vi.fn<RedisClientType["eval"]>() };
  const adapter = new RedisTokenStorageAdapter(client);

  // Each reply is structurally valid, so only the identity check can reject it.
  client.eval.mockResolvedValueOnce(JSON.stringify({ ...stored, definition: "password-reset" }));
  client.eval.mockResolvedValueOnce(JSON.stringify({ ...stored, digest: Buffer.from("other-token").toString("base64url") }));
  const lookup = { definition: "invitation", digest, now };
  await expect(adapter.findValid(lookup)).rejects.toThrow("different token identity");
  await expect(adapter.findValid(lookup)).rejects.toThrow("different token identity");
});

it("rejects malformed Redis replies and invalid inputs at the adapter boundary", async () => {
  const client = { eval: vi.fn<RedisClientType["eval"]>() };
  const adapter = new RedisTokenStorageAdapter(client);
  const now = new Date("2026-01-01T00:00:00.000Z");
  const lookup = { definition: "invitation", digest: Buffer.from("token-1"), now };

  expect(() => new RedisTokenStorageAdapter(client, { keyPrefix: "" }))
    .toThrow("key prefixes cannot be empty");
  await expect(adapter.findValid({ ...lookup, digest: new Uint8Array() }))
    .rejects.toThrow("digests cannot be empty");
  expect(client.eval).not.toHaveBeenCalled();

  // Redis commands must report one revocation and return a serialized record for lookup.
  client.eval.mockResolvedValue(2);
  await expect(adapter.revoke({ ...lookup, revokedAt: now }))
    .rejects.toThrow("Invalid Redis token revocation result");
  await expect(adapter.findValid(lookup)).rejects.toThrow("Invalid Redis token lookup result");
});
