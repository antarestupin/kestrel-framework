import type { RedisClientType } from "@redis/client";
import { expect, it, vi } from "vitest";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { RedisTokenStorageAdapter } from "./adapter.js";
import { redisTokensConfigBase } from "./configuration.js";
import { redisTokens } from "./definition.js";
import type { CreateStoredToken, TokenStorageAdapter } from "../../types.js";

it("preserves the application's explicit Redis token namespace", () => {
  const settings = { keyPrefix: "application:invitation:" };
  expect(redisTokensConfigBase.schema.parse(settings)).toStrictEqual(settings);
  expect(redisTokensConfigBase.schema.safeParse({ keyPrefix: "" }).success).toBe(false);
});

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

it("sends every lifecycle index and exact date strings with a nonempty creation batch", async () => {
  const client = { eval: vi.fn<RedisClientType["eval"]>().mockResolvedValue(1) };
  const adapter = new RedisTokenStorageAdapter(client);
  const now = new Date("2026-01-01T00:00:00.000Z");
  const first = {
    id: "consumed", definition: "invitation", digest: Buffer.from("consumed"), payload: { collection: [] },
    createdAt: new Date(now.getTime() - 10), expiresAt: new Date(now.getTime() + 1_234),
    consumedAt: now, replaceExistingForSubject: false,
  } satisfies CreateStoredToken;
  const { consumedAt: _, ...base } = first;
  const second = {
    ...base, id: "revoked", digest: Buffer.from("revoked"), subject: "account-1",
    revokedAt: now, replaceExistingForSubject: true,
  } satisfies CreateStoredToken;

  await adapter.createMany([]);
  expect(client.eval).not.toHaveBeenCalled();
  await adapter.createMany([first, second]);
  const options = client.eval.mock.calls[0]![1]!;
  expect(options.keys).toEqual(["records", "digests", "subjects", "expires", "inactive"].map((index) => `kestrel:tokens:{tokens}:${index}`));
  expect(options.arguments?.[0]).toBe("create");
  const shared = { version: 1, definition: "invitation", payload: '{"collection":[]}', createdAt: String(first.createdAt.getTime()), expiresAt: String(first.expiresAt.getTime()) };
  expect(JSON.parse(String(options.arguments?.[1]))).toStrictEqual([
    { ...shared, id: first.id, digest: first.digest.toString("base64url"), consumedAt: String(now.getTime()), replaceExistingForSubject: false },
    {
      ...shared, id: second.id, digest: second.digest.toString("base64url"), subject: second.subject,
      subjectIndex: '["invitation","account-1"]', revokedAt: String(now.getTime()), replaceExistingForSubject: true,
    },
  ]);
});

it("rejects distinct duplicate IDs, duplicate digests and subjectless replacements before Redis", async () => {
  const client = { eval: vi.fn<RedisClientType["eval"]>().mockResolvedValue(1) };
  const adapter = new RedisTokenStorageAdapter(client);
  const first = {
    id: "first", definition: "invitation", digest: Buffer.from("first"), payload: "payload",
    createdAt: new Date(0), expiresAt: new Date(1_000), replaceExistingForSubject: false,
  } satisfies CreateStoredToken;
  await expect(adapter.createMany([first, { ...first, digest: Buffer.from("other") }])).rejects.toThrow("unique");
  await expect(adapter.createMany([first, { ...first, id: "other" }])).rejects.toThrow("unique");
  await expect(adapter.createMany([{ ...first, replaceExistingForSubject: true }])).rejects.toThrow("require a unique definition and subject");
  expect(client.eval).not.toHaveBeenCalled();
});

it("rejects noncanonical decimal timestamp replies before constructing dates", async () => {
  const client = { eval: vi.fn<RedisClientType["eval"]>() };
  const adapter = new RedisTokenStorageAdapter(client);
  const digest = Buffer.from("bearer");
  const lookup = { definition: "invitation", digest, now: new Date(0) };
  const record = {
    version: 1, id: "first", definition: lookup.definition, digest: digest.toString("base64url"),
    payload: '"payload"', createdAt: "0", expiresAt: "1000",
  };

  for (const createdAt of ["+1", "1e3"]) {
    client.eval.mockResolvedValueOnce(JSON.stringify({ ...record, createdAt }));
    await expect(adapter.findValid(lookup)).rejects.toThrow();
  }
  client.eval.mockResolvedValueOnce(JSON.stringify(record));
  await expect(adapter.findValid(lookup)).resolves.toStrictEqual({
    id: "first", definition: lookup.definition, digest: new Uint8Array(digest), payload: "payload",
    createdAt: new Date(0), expiresAt: new Date(1_000),
  });
});
