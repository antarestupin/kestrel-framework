import {
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  SignJWT,
} from "jose";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineToken } from "../../definition.js";
import { TokenManager } from "../../manager.js";
import { JwtTokenKeyring } from "./keyring.js";
import { JwtTokenStrategy } from "./strategy.js";

const issuer = "https://issuer.example";
const audience = "example-api";
const type = "example-token+jwt";

describe("JwtTokenStrategy", () => {
  it("issues and verifies a strictly profiled reusable JWT", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const grant = await fixture.manager.issue(
      definition,
      { memberId: "member-1", roles: ["editor"] },
      { ttlSeconds: 60 },
    );

    expect(decodeProtectedHeader(grant.token)).toEqual({
      alg: "ES256",
      kid: "current-key",
      typ: type,
    });
    expect(decodeJwt(grant.token)).toMatchObject({
      iss: issuer,
      aud: audience,
      sub: "member-1",
      jti: "jwt-1",
      iat: 1_767_225_600,
      nbf: 1_767_225_600,
      exp: 1_767_225_660,
      token_definition: "member.access",
      token_payload: { memberId: "member-1", roles: ["editor"] },
    });
    await expect(fixture.manager.verify(definition, grant.token))
      .resolves.toEqual({ memberId: "member-1", roles: ["editor"] });

    fixture.setNow(new Date("2026-01-01T00:01:00.000Z"));
    await expect(fixture.manager.verify(definition, grant.token))
      .resolves.toBeUndefined();
  });

  it("rejects definition substitution, wrong audiences, and tampering", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const otherDefinition = createDefinition("member.invitation");
    const grant = await fixture.manager.issue(
      definition,
      { memberId: "member-1", roles: [] },
      { ttlSeconds: 60 },
    );
    const wrongAudience = new JwtTokenStrategy({
      issuer,
      audience: "other-api",
      keyring: fixture.keyring,
      type,
      now: fixture.now,
    });
    const parts = grant.token.split(".");
    const tampered = `${parts[0]}.${parts[1]!.slice(0, -1)}x.${parts[2]}`;

    await expect(fixture.manager.verify(otherDefinition, grant.token))
      .resolves.toBeUndefined();
    await expect(wrongAudience.verify(definition, grant.token))
      .resolves.toBeUndefined();
    await expect(fixture.manager.verify(definition, tampered))
      .resolves.toBeUndefined();
  });

  it("binds the JWT subject to the validated application payload", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const now = 1_767_225_600;
    const token = await new SignJWT({
      token_definition: definition.name,
      token_payload: { memberId: "member-1", roles: [] },
    })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("member-2")
      .setJti("mismatched-subject")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .sign(fixture.privateKey);

    await expect(fixture.manager.verify(definition, token))
      .resolves.toBeUndefined();
  });

  it("keeps retired verification keys valid during explicit rotation", async () => {
    const oldPair = await generateKeyPair("ES256");
    const newPair = await generateKeyPair("ES256");
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const oldKeyring = new JwtTokenKeyring({
      active: { id: "old-key", algorithm: "ES256", key: oldPair.privateKey },
      verification: [
        { id: "old-key", algorithm: "ES256", key: oldPair.publicKey },
      ],
    });
    const oldStrategy = createStrategy(oldKeyring, now);
    const definition = createDefinition("member.access");
    const oldGrant = await oldStrategy.issue(
      definition,
      [{ memberId: "member-1", roles: [] }],
      { ttlSeconds: 60 },
    );
    const rotatedKeyring = new JwtTokenKeyring({
      active: { id: "new-key", algorithm: "ES256", key: newPair.privateKey },
      verification: [
        { id: "new-key", algorithm: "ES256", key: newPair.publicKey },
        { id: "old-key", algorithm: "ES256", key: oldPair.publicKey },
      ],
    });
    const rotatedStrategy = createStrategy(rotatedKeyring, now);
    const retiredStrategy = createStrategy(new JwtTokenKeyring({
      active: { id: "new-key", algorithm: "ES256", key: newPair.privateKey },
      verification: [
        { id: "new-key", algorithm: "ES256", key: newPair.publicKey },
      ],
    }), now);

    await expect(rotatedStrategy.verify(definition, oldGrant[0]!.token))
      .resolves.toMatchObject({
        payload: { memberId: "member-1", roles: [] },
      });
    await expect(retiredStrategy.verify(definition, oldGrant[0]!.token))
      .resolves.toBeUndefined();
  });

  it("rejects unsupported stateful semantics and excessive lifetimes", async () => {
    const fixture = await createFixture({ maximumTokenLifetimeSeconds: 60 });
    const singleUse = defineToken({
      name: "account.password-reset",
      payload: z.object({ accountId: z.string() }),
      usage: "single",
      strategy: "jwt",
    });
    const replacement = defineToken({
      name: "member.access",
      payload: z.object({ memberId: z.string() }),
      strategy: "jwt",
      replacement: "same-subject",
      subject: ({ memberId }) => memberId,
    });
    const reusable = createDefinition("member.lookup");

    await expect(fixture.strategy.issue(
      singleUse,
      [{ accountId: "account-1" }],
      { ttlSeconds: 60 },
    )).rejects.toThrow("cannot guarantee single-use");
    await expect(fixture.strategy.issue(
      replacement,
      [{ memberId: "member-1" }],
      { ttlSeconds: 60 },
    )).rejects.toThrow("cannot replace");
    await expect(fixture.manager.issue(
      reusable,
      { memberId: "member-1", roles: [] },
      { ttlSeconds: 61 },
    )).rejects.toThrow("exceeds 60 seconds");
  });
});

describe("JwtTokenKeyring", () => {
  it("requires an exact verification key for the active signer", async () => {
    const pair = await generateKeyPair("ES256");

    expect(() => new JwtTokenKeyring({
      active: { id: "key-1", algorithm: "ES256", key: pair.privateKey },
      verification: [],
    })).toThrow("requires a verification key");
    expect(() => new JwtTokenKeyring({
      active: { id: "key-1", algorithm: "ES256", key: pair.privateKey },
      verification: [
        { id: "key-1", algorithm: "ES384", key: pair.publicKey },
      ],
    })).toThrow("same signing and verification algorithm");
    expect(() => new JwtTokenKeyring({
      active: {
        id: "key-1",
        algorithm: "none" as "ES256",
        key: pair.privateKey,
      },
      verification: [{
        id: "key-1",
        algorithm: "none" as "ES256",
        key: pair.publicKey,
      }],
    })).toThrow('algorithm "none" is not supported');
  });
});

function createDefinition(name: string) {
  return defineToken({
    name,
    payload: z.object({
      memberId: z.string(),
      roles: z.array(z.string()),
    }),
    strategy: "jwt",
    subject: ({ memberId }) => memberId,
  });
}

async function createFixture(
  overrides: { maximumTokenLifetimeSeconds?: number } = {},
) {
  const pair = await generateKeyPair("ES256");
  let currentNow = new Date("2026-01-01T00:00:00.000Z");
  let sequence = 0;
  const now = () => currentNow;
  const keyring = new JwtTokenKeyring({
    active: { id: "current-key", algorithm: "ES256", key: pair.privateKey },
    verification: [
      { id: "current-key", algorithm: "ES256", key: pair.publicKey },
    ],
  });
  const strategy = new JwtTokenStrategy({
    issuer,
    audience,
    keyring,
    type,
    now,
    createId: () => `jwt-${++sequence}`,
    ...overrides,
  });
  const manager = new TokenManager(
    { jwt: strategy },
    { defaultStrategy: "jwt", maxPayloadBytes: 4_096 },
  );

  return {
    keyring,
    manager,
    now,
    privateKey: pair.privateKey,
    setNow: (value: Date) => {
      currentNow = value;
    },
    strategy,
  };
}

function createStrategy(
  keyring: JwtTokenKeyring,
  now: () => Date,
): JwtTokenStrategy {
  return new JwtTokenStrategy({ issuer, audience, keyring, type, now });
}
