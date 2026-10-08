import { createHash } from "node:crypto";

import {
  decodeJwt,
  generateKeyPair,
} from "jose";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryTokenStorageAdapter } from "../../adapters/memory/index.js";
import { defineToken } from "../../definition.js";
import { TokenManager } from "../../manager.js";
import { JwtTokenKeyring } from "../jwt/keyring.js";
import { JwtTokenStrategy } from "../jwt/strategy.js";
import { HybridTokenStrategy } from "./strategy.js";

const issuer = "https://issuer.example";
const audience = "example-api";
const type = "example-hybrid-token+jwt";
const initialNow = new Date("2026-01-01T00:00:00.000Z");

describe("HybridTokenStrategy", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  it("keeps application data in the signed JWT and only lifecycle state in storage", async () => {
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: ["editor"] };
    const grant = await fixture.manager.issue(
      definition,
      payload,
      { ttlSeconds: 60 },
    );
    const claims = decodeJwt(grant.token);
    const state = await fixture.store.findValid({
      definition: definition.name,
      digest: digestId(claims.jti!),
      now: initialNow,
    });

    expect(claims).toMatchObject({
      jti: "hybrid-1",
      token_definition: definition.name,
      token_payload: payload,
    });
    expect(state).toMatchObject({
      definition: definition.name,
      subject: "member-1",
      payload: { tokenRepresentation: "hybrid-jwt" },
      expiresAt: grant.expiresAt,
    });
    expect(state?.payload).not.toEqual(payload);
    await expect(fixture.manager.verify(definition, grant.token))
      .resolves.toEqual(payload);
  });

  it("atomically consumes a signed token exactly once", async () => {
    const definition = createDefinition("account.password-reset", {
      usage: "single",
    });
    const grant = await fixture.manager.issue(
      definition,
      { memberId: "member-1", roles: [] },
      { ttlSeconds: 60 },
    );
    const resolutions = await Promise.all([
      fixture.manager.consume(definition, grant.token),
      fixture.manager.consume(definition, grant.token),
    ]);

    expect(resolutions.filter((resolution) => resolution !== undefined))
      .toEqual([{ memberId: "member-1", roles: [] }]);
  });

  it("supports replacement, token revocation, and subject lifecycle operations", async () => {
    const replacement = createDefinition("member.invitation", {
      replacement: "same-subject",
    });
    const first = await fixture.manager.issue(
      replacement,
      { memberId: "member-1", roles: ["reader"] },
      { ttlSeconds: 60 },
    );
    const second = await fixture.manager.issue(
      replacement,
      { memberId: "member-1", roles: ["editor"] },
      { ttlSeconds: 60 },
    );

    await expect(fixture.manager.verify(replacement, first.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.verify(replacement, second.token))
      .resolves.toEqual({ memberId: "member-1", roles: ["editor"] });
    await expect(fixture.manager.revoke(replacement, second.token))
      .resolves.toBe(true);
    await expect(fixture.manager.verify(replacement, second.token))
      .resolves.toBeUndefined();

    const third = await fixture.manager.issue(
      replacement,
      { memberId: "member-1", roles: [] },
      { ttlSeconds: 60 },
    );
    await expect(fixture.manager.revokeForSubject(replacement, "member-1"))
      .resolves.toBe(1);
    await expect(fixture.manager.verify(replacement, third.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.deleteForSubject(replacement, "member-1"))
      .resolves.toBe(3);
  });

  it("rejects a valid signed JWT when no matching server state exists", async () => {
    const definition = createDefinition("member.lookup");
    const stateless = new JwtTokenStrategy({
      issuer,
      audience,
      keyring: fixture.keyring,
      type,
      now: fixture.now,
      createId: () => "untracked-jwt",
    });
    const [grant] = await stateless.issue(
      definition,
      [{ memberId: "member-1", roles: [] }],
      { ttlSeconds: 60 },
    );

    await expect(fixture.manager.verify(definition, grant!.token))
      .resolves.toBeUndefined();
  });

  it("expires and prunes hybrid lifecycle state", async () => {
    const definition = createDefinition("member.temporary-access");
    const grant = await fixture.manager.issue(
      definition,
      { memberId: "member-1", roles: [] },
      { ttlSeconds: 60 },
    );
    const afterExpiration = new Date("2026-01-01T00:01:00.000Z");
    fixture.setNow(afterExpiration);

    await expect(fixture.manager.verify(definition, grant.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.prune({
      expiredBefore: afterExpiration,
      inactiveBefore: initialNow,
      limit: 10,
    })).resolves.toBe(1);
  });
});

function createDefinition(
  name: string,
  lifecycle: {
    usage?: "multiple" | "single";
    replacement?: "none" | "same-subject";
  } = {},
) {
  return defineToken({
    name,
    payload: z.object({
      memberId: z.string(),
      roles: z.array(z.string()),
    }),
    strategy: "hybrid",
    ...(lifecycle.usage === undefined ? {} : { usage: lifecycle.usage }),
    ...(lifecycle.replacement === undefined
      ? {}
      : { replacement: lifecycle.replacement }),
    subject: ({ memberId }) => memberId,
  });
}

async function createFixture() {
  const pair = await generateKeyPair("ES256");
  let jwtSequence = 0;
  let stateSequence = 0;
  let currentNow = initialNow;
  const now = () => currentNow;
  const keyring = new JwtTokenKeyring({
    active: { id: "current-key", algorithm: "ES256", key: pair.privateKey },
    verification: [
      { id: "current-key", algorithm: "ES256", key: pair.publicKey },
    ],
  });
  const store = new MemoryTokenStorageAdapter();
  const strategy = new HybridTokenStrategy(store, {
    issuer,
    audience,
    keyring,
    type,
    now,
    createId: () => `hybrid-${++jwtSequence}`,
    createStateId: () => `state-${++stateSequence}`,
  });
  const manager = new TokenManager(
    { hybrid: strategy },
    { defaultStrategy: "hybrid", maxPayloadBytes: 4_096 },
  );

  return {
    keyring,
    manager,
    now,
    setNow: (value: Date) => {
      currentNow = value;
    },
    store,
  };
}

function digestId(id: string): Uint8Array {
  return createHash("sha256").update(id).digest();
}
