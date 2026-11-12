import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { MemoryTokenStorageAdapter } from "./adapters/memory/index.js";
import { defineToken } from "./definition.js";
import { TokenManager } from "./manager.js";
import { StoredTokenStrategy } from "./stored_strategy.js";
import type { TokenStrategy } from "./types.js";

it("rejects invalid token definitions at declaration time", () => {
  const payload = z.string();

  // A replacement policy must identify the subject whose earlier grants are revoked.
  expect(() => defineToken({ name: "member.invitation", payload, replacement: "same-subject" }))
    .toThrow("requires a subject resolver");
  expect(() => defineToken({ name: "Member.Invitation", payload }))
    .toThrow("Token name");
  expect(() => defineToken({ name: "member.invitation", payload, strategy: "a".repeat(129) }))
    .toThrow("Token strategy name");
});

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

  it.each([0, 1.5])("rejects a payload budget of %s bytes", (maxPayloadBytes) => {
    expect(() => new TokenManager({}, { maxPayloadBytes }))
      .toThrow("Token maxPayloadBytes must be a positive integer");
  });

  it("enforces the inclusive UTF-8 budget and rejects unencodable payloads before issuing", async () => {
    const { manager, store } = createFixture({ maxPayloadBytes: 4 });
    const createMany = vi.spyOn(store, "createMany");
    const text = defineToken({ name: "test.text", payload: z.string() });
    const bigint = defineToken({ name: "test.bigint", payload: z.bigint() });
    const options = { ttlSeconds: 60 };

    // JSON quotes count toward the budget, and a multibyte character is wider than one code unit.
    await expect(manager.issue(text, "éa", options)).rejects.toThrow("exceeds 4 bytes");
    await expect(manager.issue(bigint, 1n, options)).rejects.toThrow("payload must be JSON-compatible");
    expect(createMany).not.toHaveBeenCalled();

    const grant = await manager.issue(text, "é", options);
    await expect(manager.verify(text, grant.token)).resolves.toBe("é");
  });

  it("fails closed when a strategy resolves a bearer to an invalid payload", async () => {
    const strategy: TokenStrategy = {
      capabilities: { pruning: false, revocation: false, singleUse: false, subjectDeletion: false },
      issue: async () => [],
      verify: async () => ({ payload: 123, expiresAt: new Date("2026-01-01T00:01:00.000Z") }),
    };
    const manager = new TokenManager({ stored: strategy }, { maxPayloadBytes: 32 });
    const definition = defineToken({ name: "test.text", payload: z.string() });

    // The adapter result still has to pass the definition's runtime schema.
    await expect(manager.verify(definition, "stored-bearer")).resolves.toBeUndefined();
  });

  it("does not issue a batch with an unencodable payload or an invalid subject", async () => {
    const fixture = createFixture();
    const createMany = vi.spyOn(fixture.store, "createMany");
    const options = { ttlSeconds: 60 };
    const missingPayload = defineToken({ name: "test.missing-payload", payload: z.undefined() });
    const replacement = defineToken({
      name: "test.optional-subject",
      payload: z.object({ subject: z.string().optional() }),
      replacement: "same-subject",
      subject: ({ subject }) => subject,
    });

    await expect(fixture.manager.issue(missingPayload, undefined, options))
      .rejects.toThrow("payload must be JSON-compatible");
    await expect(fixture.manager.issueMany(replacement, [{ subject: "valid" }, {}], options))
      .rejects.toThrow("subjects must not be empty");
    await expect(fixture.manager.issue(replacement, { subject: " \t " }, options))
      .rejects.toThrow("subjects must not be empty");
    expect(createMany).not.toHaveBeenCalled();

    // An optional subject is valid for issuance when the definition never replaces by subject.
    const subjectOptional = defineToken({
      name: "test.subjectless",
      payload: replacement.payloadSchema,
      subject: ({ subject }) => subject,
    });
    const grant = await fixture.manager.issue(subjectOptional, {}, options);
    await expect(fixture.manager.verify(subjectOptional, grant.token)).resolves.toEqual({});
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

  it("rejects subject operations for a definition without a subject resolver", async () => {
    const { manager } = createFixture();
    const definition = defineToken({ name: "test.bearer", payload: z.string() });
    const grant = await manager.issue(definition, "payload", { ttlSeconds: 60 });

    expect(() => manager.revokeForSubject(definition, "arbitrary"))
      .toThrow("does not declare a subject");
    expect(() => manager.deleteForSubject(definition, "arbitrary"))
      .toThrow("does not declare a subject");
    await expect(manager.verify(definition, grant.token)).resolves.toBe("payload");
    await expect(manager.revoke(definition, grant.token)).resolves.toBe(true);
    await expect(manager.verify(definition, grant.token)).resolves.toBeUndefined();
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

  it("requires advertised lifecycle guarantees before calling strategy methods", async () => {
    const consume = vi.fn();
    const revoke = vi.fn();
    const revokeForSubject = vi.fn();
    const deleteForSubject = vi.fn();
    const manager = new TokenManager({
      stored: {
        capabilities: { pruning: false, revocation: false, singleUse: false, subjectDeletion: false },
        issue: async () => [],
        verify: async () => undefined,
        consume,
        revoke,
        revokeForSubject,
        deleteForSubject,
      },
    }, { maxPayloadBytes: 32 });
    const definition = defineToken({
      name: "account.confirmation",
      payload: z.string(),
      subject: (value) => value,
      usage: "single",
    });

    // A method on a custom strategy does not by itself advertise the matching guarantee.
    await expect(manager.consume(definition, "bearer")).rejects.toThrow("does not support single-use");
    expect(() => manager.revoke(definition, "bearer")).toThrow("does not support revocation");
    expect(() => manager.revokeForSubject(definition, "account-1")).toThrow("does not support revocation");
    expect(() => manager.deleteForSubject(definition, "account-1")).toThrow("does not support subject deletion");
    expect(consume).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(revokeForSubject).not.toHaveBeenCalled();
    expect(deleteForSubject).not.toHaveBeenCalled();
  });

  it("prunes each eligible store once across several strategies", async () => {
    const pruningScope = {};
    const prune = vi.fn().mockResolvedValue(2);
    const independentPrune = vi.fn().mockResolvedValue(3);
    const unsupportedPrune = vi.fn();
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
    const { pruningScope: _scope, ...independent } = createStrategy();
    const manager = new TokenManager(
      {
        stored: createStrategy(),
        hybrid: createStrategy(),
        independent: { ...independent, prune: independentPrune },
        signed: {
          ...independent,
          capabilities: { ...independent.capabilities, pruning: false },
          prune: unsupportedPrune,
        },
      },
      { maxPayloadBytes: 1_024 },
    );

    await expect(manager.prune({
      expiredBefore: new Date("2026-01-01T00:00:00.000Z"),
      inactiveBefore: new Date("2025-12-01T00:00:00.000Z"),
      limit: 100,
    })).resolves.toBe(5);
    expect(prune).toHaveBeenCalledOnce();
    expect(independentPrune).toHaveBeenCalledOnce();
    expect(unsupportedPrune).not.toHaveBeenCalled();
  });

  it("rejects invalid pruning limits and dates without changing retained state", async () => {
    const fixture = createFixture();
    const prune = vi.spyOn(fixture.store, "prune");
    const options = {
      expiredBefore: new Date("2026-01-01T00:00:00.000Z"),
      inactiveBefore: new Date("2025-12-01T00:00:00.000Z"),
      limit: 100,
    };

    await expect(fixture.manager.prune({ ...options, limit: 0 }))
      .rejects.toThrow("limit must be a positive integer");
    await expect(fixture.manager.prune({ ...options, expiredBefore: new Date(NaN) }))
      .rejects.toThrow("dates must be valid");
    await expect(fixture.manager.prune({ ...options, inactiveBefore: new Date(NaN) }))
      .rejects.toThrow("dates must be valid");
    expect(prune).not.toHaveBeenCalled();
  });

  it("reports missing strategies and failed issuance instead of returning a token", async () => {
    const manager = new TokenManager({
      stored: {
        capabilities: { pruning: false, revocation: false, singleUse: false, subjectDeletion: false },
        issue: async () => [],
        verify: async () => undefined,
      },
    }, { maxPayloadBytes: 1_024 });
    const payload = z.string();
    const unregistered = defineToken({ name: "test.unregistered", payload, strategy: "missing" });
    const empty = defineToken({ name: "test.empty", payload });

    await expect(manager.issue(unregistered, "value", { ttlSeconds: 60 }))
      .rejects.toThrow('strategy "missing" required by "test.unregistered" is not registered');
    await expect(manager.issue(empty, "value", { ttlSeconds: 60 }))
      .rejects.toThrow("did not return the issued token");
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
