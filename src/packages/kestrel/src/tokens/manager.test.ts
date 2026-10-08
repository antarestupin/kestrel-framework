import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { MemoryTokenStorageAdapter } from "./adapters/memory/index.js";
import { defineToken } from "./definition.js";
import { TokenManager } from "./manager.js";
import { StoredTokenStrategy } from "./stored_strategy.js";
import type { TokenStrategy } from "./types.js";

describe("TokenManager", () => {
  it("issues, replaces, and atomically consumes single-use tokens", async () => {
    const fixture = createFixture();
    const definition = defineToken({
      name: "account.password-reset",
      payload: z.object({ accountId: z.string() }),
      usage: "single",
      replacement: "same-subject",
      subject: ({ accountId }) => accountId,
    });
    const first = await fixture.manager.issue(
      definition,
      { accountId: "account-1" },
      { ttlSeconds: 60 },
    );
    const second = await fixture.manager.issue(
      definition,
      { accountId: "account-1" },
      { ttlSeconds: 60 },
    );

    await expect(fixture.manager.consume(definition, first.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.consume(definition, second.token))
      .resolves.toEqual({ accountId: "account-1" });
    await expect(fixture.manager.consume(definition, second.token))
      .resolves.toBeUndefined();
  });

  it("binds a bearer value to its definition", async () => {
    const fixture = createFixture();
    const invitation = defineToken({
      name: "member.invitation",
      payload: z.object({ memberId: z.string() }),
    });
    const download = defineToken({
      name: "document.download",
      payload: z.object({ memberId: z.string() }),
    });
    const grant = await fixture.manager.issue(
      invitation,
      { memberId: "member-1" },
      { ttlSeconds: 60 },
    );

    await expect(fixture.manager.verify(download, grant.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.verify(invitation, grant.token))
      .resolves.toEqual({ memberId: "member-1" });
  });

  it("rejects unsafe lifecycle calls and malformed bearer values", async () => {
    const fixture = createFixture();
    const singleUse = defineToken({
      name: "account.confirmation",
      payload: z.object({ accountId: z.string() }),
      usage: "single",
    });
    const reusable = defineToken({
      name: "member.lookup",
      payload: z.object({ memberId: z.string() }),
    });

    await expect(fixture.manager.verify(singleUse, "invalid"))
      .rejects.toThrow("must be consumed");
    await expect(fixture.manager.consume(reusable, "invalid"))
      .rejects.toThrow("must be verified");
    await expect(fixture.manager.verify(reusable, "invalid"))
      .resolves.toBeUndefined();
  });

  it("validates JSON round trips, payload bounds, and replacement batches", async () => {
    const fixture = createFixture({ maxPayloadBytes: 32 });
    const replacementFixture = createFixture();
    const dated = defineToken({
      name: "test.dated",
      payload: z.object({ at: z.date() }),
    });
    const bounded = defineToken({
      name: "test.bounded",
      payload: z.object({ value: z.string() }),
    });
    const replacement = defineToken({
      name: "test.replacement",
      payload: z.object({ subject: z.string(), value: z.string() }),
      replacement: "same-subject",
      subject: ({ subject }) => subject,
    });

    await expect(fixture.manager.issue(
      dated,
      { at: new Date() },
      { ttlSeconds: 60 },
    )).rejects.toThrow();
    await expect(fixture.manager.issue(
      bounded,
      { value: "x".repeat(100) },
      { ttlSeconds: 60 },
    )).rejects.toThrow("exceeds 32 bytes");
    await expect(replacementFixture.manager.issueMany(
      replacement,
      [
        { subject: "same", value: "first" },
        { subject: "same", value: "second" },
      ],
      { ttlSeconds: 60 },
    )).rejects.toThrow("same replacement subject");
  });

  it("revokes and physically deletes tokens by subject", async () => {
    const fixture = createFixture();
    const definition = defineToken({
      name: "account.operation",
      payload: z.object({ accountId: z.string() }),
      subject: ({ accountId }) => accountId,
    });
    const first = await fixture.manager.issue(
      definition,
      { accountId: "account-1" },
      { ttlSeconds: 60 },
    );

    await expect(fixture.manager.revokeForSubject(definition, "account-1"))
      .resolves.toBe(1);
    await expect(fixture.manager.verify(definition, first.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.deleteForSubject(definition, "account-1"))
      .resolves.toBe(1);
  });

  it("rejects lifecycle guarantees absent from a selected strategy", async () => {
    const signed = {
      capabilities: {
        pruning: false,
        revocation: false,
        singleUse: false,
        subjectDeletion: false,
      },
      issue: async () => [{
        token: "signed-token",
        expiresAt: new Date("2026-01-01T00:01:00.000Z"),
      }],
      verify: async () => undefined,
    } satisfies TokenStrategy;
    const manager = new TokenManager(
      { signed },
      { defaultStrategy: "signed", maxPayloadBytes: 1_024 },
    );
    const definition = defineToken({
      name: "account.signed-operation",
      payload: z.object({ accountId: z.string() }),
      usage: "single",
      strategy: "signed",
      subject: ({ accountId }) => accountId,
    });

    await expect(manager.issue(
      definition,
      { accountId: "account-1" },
      { ttlSeconds: 60 },
    )).rejects.toThrow("does not support single-use");
    expect(() => manager.revokeForSubject(definition, "account-1"))
      .toThrow("does not support revocation");
    expect(() => manager.deleteForSubject(definition, "account-1"))
      .toThrow("does not support subject deletion");
  });

  it("prunes a shared store only once across several strategies", async () => {
    const pruningScope = {};
    const prune = vi.fn().mockResolvedValue(2);
    const createStrategy = () => ({
      capabilities: {
        pruning: true,
        revocation: false,
        singleUse: false,
        subjectDeletion: false,
      },
      pruningScope,
      issue: async () => [],
      verify: async () => undefined,
      prune,
    }) satisfies TokenStrategy;
    const manager = new TokenManager(
      { stored: createStrategy(), hybrid: createStrategy() },
      { maxPayloadBytes: 1_024 },
    );

    await expect(manager.prune({
      expiredBefore: new Date("2026-01-01T00:00:00.000Z"),
      inactiveBefore: new Date("2025-12-01T00:00:00.000Z"),
      limit: 100,
    })).resolves.toBe(2);
    expect(prune).toHaveBeenCalledOnce();
  });
});

function createFixture(
  overrides: { maxPayloadBytes?: number } = {},
) {
  let sequence = 0;
  const store = new MemoryTokenStorageAdapter();
  const strategy = new StoredTokenStrategy(store, {
    tokenBytes: 32,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    randomToken: () => Buffer.alloc(32, ++sequence).toString("base64url"),
    createId: () => `token-${sequence}`,
  });
  const manager = new TokenManager(
    { stored: strategy },
    { maxPayloadBytes: overrides.maxPayloadBytes ?? 1_024 },
  );

  return { manager, store };
}
