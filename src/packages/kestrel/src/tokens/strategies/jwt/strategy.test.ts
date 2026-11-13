import {
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { defineToken } from "../../definition.js";
import { TokenManager } from "../../manager.js";
import { JwtTokenKeyring, type JwtTokenAlgorithm, type JwtTokenKey } from "./keyring.js";
import { JwtTokenStrategy, type JwtTokenStrategyOptions } from "./strategy.js";

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
    const sign = (memberId: string, subject: string) => new SignJWT({
      token_definition: definition.name,
      token_payload: { memberId, roles: [] },
    })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setJti("mismatched-subject")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60)
      .sign(fixture.privateKey);

    await expect(fixture.manager.verify(definition, await sign("member-1", "member-2")))
      .resolves.toBeUndefined();
    // A matching signed claim must still name a non-empty application subject.
    await expect(fixture.manager.verify(definition, await sign(" ", " ")))
      .resolves.toBeUndefined();
  });

  it("checks signed temporal claims and the JWT ID independently of the signature", async () => {
    const fixture = await createFixture({ clockToleranceSeconds: 2 });
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const grant = await fixture.manager.issue(definition, payload, { ttlSeconds: 60 });
    const claims = decodeJwt(grant.token);
    const issuedAt = claims.iat!;
    const sign = (changes: JWTPayload) => new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .sign(fixture.privateKey);

    // The allowed clock skew includes its upper boundary.
    const withinTolerance = await sign({ iat: issuedAt + 2, nbf: issuedAt + 2 });
    await expect(fixture.manager.verify(definition, withinTolerance)).resolves.toEqual(payload);
    const invalidClaims = [
      { jti: " \t " },
      // JOSE requires jti presence. Kestrel also requires a string ID.
      { jti: 42 as unknown as string },
      { nbf: issuedAt - 1 },
      { iat: issuedAt - 0.5, nbf: issuedAt - 0.5 },
      { exp: issuedAt + 0.5 },
      // Tolerance can let JOSE accept a zero-length validity window.
      { exp: issuedAt },
      { iat: issuedAt + 3, nbf: issuedAt + 3 },
    ];
    for (const changes of invalidClaims) {
      const token = await sign(changes);
      await expect(fixture.manager.verify(definition, token)).resolves.toBeUndefined();
    }
  });

  it("accepts the Unix epoch and rejects a negative signed NumericDate", async () => {
    const fixture = await createFixture();
    fixture.setNow(new Date(0));
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const grant = await fixture.manager.issue(definition, payload, { ttlSeconds: 60 });
    const claims = decodeJwt(grant.token);

    expect(claims).toMatchObject({ iat: 0, nbf: 0, exp: 60 });
    await expect(fixture.manager.verify(definition, grant.token)).resolves.toEqual(payload);

    // Keep both start times equal so only their negative value breaks the profile.
    const negative = await new SignJWT({ ...claims, iat: -1, nbf: -1 })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .sign(fixture.privateKey);
    await expect(fixture.manager.verify(definition, negative)).resolves.toBeUndefined();
  });

  it("enforces the inclusive maximum lifetime when signing and verifying", async () => {
    const fixture = await createFixture({ maximumTokenLifetimeSeconds: 60 });
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const grant = await fixture.manager.issue(definition, payload, { ttlSeconds: 60 });
    await expect(fixture.manager.verify(definition, grant.token)).resolves.toEqual(payload);

    // Sign an over-limit token outside the strategy to isolate verification.
    const claims = decodeJwt(grant.token);
    const overLimit = await new SignJWT({ ...claims, exp: claims.exp! + 1 })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .sign(fixture.privateKey);
    await expect(fixture.manager.verify(definition, overLimit)).resolves.toBeUndefined();
  });

  it("rejects a signed expiration outside the runtime Date range", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const [grant] = await fixture.strategy.issue(definition, [payload], { ttlSeconds: 60 });
    const claims = decodeJwt(grant!.token);
    const sign = (exp: number) => new SignJWT({ ...claims, exp })
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .sign(fixture.privateKey);

    // A trusted signature still cannot express a lifecycle outside the runtime's clock domain.
    const lastDate = 8_640_000_000_000;
    await expect(fixture.strategy.verify(definition, await sign(lastDate))).resolves.toEqual({
      payload, expiresAt: new Date(lastDate * 1_000),
    });
    await expect(fixture.strategy.verify(definition, await sign(lastDate + 1)))
      .resolves.toBeUndefined();
  });

  it("fails closed if the verification clock cannot establish whether a token is expired", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const grant = await fixture.manager.issue(definition, payload, { ttlSeconds: 60 });
    await expect(fixture.manager.verify(definition, grant.token)).resolves.toEqual(payload);

    // An unavailable clock must never allow an expired bearer through JWT validation.
    fixture.setNow(grant.expiresAt);
    await expect(fixture.manager.verify(definition, grant.token)).resolves.toBeUndefined();
    fixture.setNow(new Date(NaN));
    await expect(fixture.manager.verify(definition, grant.token)).resolves.toBeUndefined();
  });

  it("requires the signed application payload even if the schema has a default", async () => {
    const fixture = await createFixture();
    const definition = defineToken({
      name: "member.access",
      strategy: "jwt",
      payload: z.string().default("member-1"),
    });
    const grant = await fixture.manager.issue(definition, "member-1", { ttlSeconds: 60 });
    const { token_payload: _omitted, ...claims } = decodeJwt(grant.token);
    const signed = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "current-key", typ: type })
      .sign(fixture.privateKey);

    await expect(fixture.manager.verify(definition, grant.token)).resolves.toBe("member-1");
    await expect(fixture.manager.verify(definition, signed)).resolves.toBeUndefined();
  });

  it("rejects issuance from before the supported JWT clock domain", async () => {
    const fixture = await createFixture();
    fixture.setNow(new Date(-1_000));
    await expect(fixture.strategy.issue(createDefinition("member.access"), [
      { memberId: "member-1", roles: [] },
    ], { ttlSeconds: 60 })).rejects.toThrow("JWT issuance time");
  });

  it("accepts a subjectless token for either configured audience until it expires", async () => {
    const fixture = await createFixture();
    const definition = defineToken({
      name: "service.access",
      payload: z.object({ scope: z.string() }),
      strategy: "jwt",
    });
    const audiences = [audience, "second-api"];
    const configuredAudiences = [...audiences];
    const strategy = new JwtTokenStrategy({
      issuer, audience: configuredAudiences, keyring: fixture.keyring,
    });
    // Mutating the caller's array after configuration must not change the signed audience.
    configuredAudiences.push("other-api");
    const payload = { scope: "read" };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(fixture.now());
      const [grant] = await strategy.issue(definition, [payload], { ttlSeconds: 60 });
      const header = { alg: "ES256", kid: "current-key", typ: "token+jwt" };
      expect(decodeProtectedHeader(grant!.token)).toEqual(header);
      const claims = decodeJwt(grant!.token);
      expect(claims.aud).toEqual(audiences);
      expect(claims).not.toHaveProperty("sub");

      for (const acceptedAudience of audiences) {
        const verifier = new JwtTokenStrategy({
          issuer, audience: acceptedAudience, keyring: fixture.keyring,
        });
        await expect(verifier.verify(definition, grant!.token)).resolves.toEqual({
          payload, expiresAt: grant!.expiresAt,
        });
      }

      // A trusted signature cannot add a subject to a subjectless definition.
      const unexpectedSubject = await new SignJWT({ ...claims, sub: "member-1" })
        .setProtectedHeader(header)
        .sign(fixture.privateKey);
      await expect(strategy.verify(definition, unexpectedSubject)).resolves.toBeUndefined();

      vi.setSystemTime(grant!.expiresAt);
      await expect(strategy.verify(definition, grant!.token)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an empty bearer value and enforces the encoded size limit", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: ["reader"] };
    const [grant] = await fixture.strategy.issue(definition, [payload], { ttlSeconds: 60 });
    const maxTokenLength = grant!.token.length - 1;
    const limited = new JwtTokenStrategy({
      issuer, audience, keyring: fixture.keyring, type, now: fixture.now,
      createId: () => "jwt-1",
      maxTokenLength,
    });
    const exactLimit = new JwtTokenStrategy({
      issuer, audience, keyring: fixture.keyring, type, now: fixture.now,
      createId: () => "jwt-1",
      maxTokenLength: grant!.token.length,
    });

    // Use a valid signature to isolate rejection by the configured length limit.
    await expect(fixture.strategy.verify(definition, grant!.token)).resolves.toMatchObject({ payload });
    await expect(exactLimit.verify(definition, grant!.token)).resolves.toMatchObject({ payload });
    await expect(exactLimit.issue(definition, [payload], { ttlSeconds: 60 }))
      .resolves.toMatchObject([{ expiresAt: grant!.expiresAt }]);
    await expect(limited.verify(definition, grant!.token)).resolves.toBeUndefined();
    await expect(limited.verify(definition, "")).resolves.toBeUndefined();
    await expect(limited.issue(definition, [payload], { ttlSeconds: 60 }))
      .rejects.toThrow(`exceeds ${maxTokenLength} characters`);
  });

  it("rejects an expiration that rounds to the issuance second", async () => {
    const fixture = await createFixture();
    const definition = createDefinition("member.access");
    const payload = { memberId: "member-1", roles: [] };
    const expiresAt = new Date(fixture.now().getTime() + 999);

    // JWT NumericDate claims discard fractional seconds.
    await expect(fixture.strategy.issue(definition, [payload], { expiresAt }))
      .rejects.toThrow("at least one complete second after issuance");
    await expect(fixture.strategy.issue(definition, [payload], { ttlSeconds: 1 }))
      .resolves.toEqual([{
        token: expect.any(String),
        expiresAt: new Date(fixture.now().getTime() + 1_000),
      }]);
  });

  it.each([
    { options: { issuer: "" }, error: "JWT issuer must not be empty" },
    { options: { type: " " }, error: "JWT type must not be empty" },
    { options: { audience: [] }, error: "audience must contain at least one value" },
    { options: { audience: [audience, audience] }, error: "audience values must be unique" },
    { options: { audience: [" "] }, error: "audience must not be empty" },
    { options: { maxTokenLength: 0 }, error: "maxTokenLength must be a positive safe integer" },
    { options: { maxTokenLength: 1.5 }, error: "maxTokenLength must be a positive safe integer" },
    { options: { clockToleranceSeconds: -1 }, error: "clockToleranceSeconds must be a non-negative safe integer" },
    { options: { clockToleranceSeconds: 0.5 }, error: "clockToleranceSeconds must be a non-negative safe integer" },
    { options: { maximumTokenLifetimeSeconds: 0 }, error: "JWT maximumTokenLifetimeSeconds must be a positive safe integer" },
  ] satisfies { options: Partial<JwtTokenStrategyOptions>; error: string }[])(
    "rejects invalid profile options $options",
    async ({ options, error }) => {
      const { keyring } = await createFixture();

      expect(() => new JwtTokenStrategy({ issuer, audience, keyring, ...options }))
        .toThrow(error);
    },
  );

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
    expect(fixture.strategy.capabilities).toEqual({
      pruning: false, revocation: false, singleUse: false, subjectDeletion: false,
    });
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

  it("rejects blank application subjects and blank generated IDs during signing", async () => {
    const fixture = await createFixture();
    const blankSubject = createDefinition("member.access");
    await expect(fixture.strategy.issue(blankSubject, [{ memberId: " ", roles: [] }], { ttlSeconds: 60 }))
      .rejects.toThrow("JWT subject must not be empty.");
    const blankId = new JwtTokenStrategy({
      issuer, audience, keyring: fixture.keyring, now: fixture.now, createId: () => "\t",
    });
    await expect(blankId.issue(blankSubject, [{ memberId: "member-1", roles: [] }], { ttlSeconds: 60 }))
      .rejects.toThrow("JWT ID must not be empty.");
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

  it("rejects duplicate and invalid key IDs before resolving a signer", async () => {
    const pair = await generateKeyPair("ES256");
    const active = { id: "key-1", algorithm: "ES256" as const, key: pair.privateKey };
    const verification = { ...active, key: pair.publicKey };

    expect(() => new JwtTokenKeyring({ active, verification: [verification, verification] }))
      .toThrow('JWT verification key ID "key-1" is registered more than once');
    for (const id of [" ", "k".repeat(129)]) {
      expect(() => new JwtTokenKeyring({ active: { ...active, id }, verification: [] }))
        .toThrow("JWT key IDs must be non-empty and at most 128 characters");
    }
  });

  it("requires both key ID and algorithm to resolve a verifier", async () => {
    const { keyring } = await createFixture();

    expect(keyring.resolve("current-key", "ES256")).toMatchObject({
      id: "current-key", algorithm: "ES256",
    });
    expect(keyring.resolve(undefined, "ES256")).toBeUndefined();
    expect(keyring.resolve("current-key", undefined)).toBeUndefined();
    expect(keyring.resolve("current-key", "ES384")).toBeUndefined();
    expect(keyring.resolve("unknown", "ES256")).toBeUndefined();
  });

  it("snapshots getter-backed key descriptors before signing and lookup", async () => {
    const pair = await generateKeyPair("ES256");
    class KeyDescriptor implements JwtTokenKey {
      public constructor(private readonly input: JwtTokenKey["key"]) {}
      public get id(): string { return "k".repeat(128); }
      public get algorithm(): JwtTokenAlgorithm { return "ES256"; }
      public get key(): JwtTokenKey["key"] { return this.input; }
    }
    const active = new KeyDescriptor(pair.privateKey);
    const keyring = new JwtTokenKeyring({ active, verification: [new KeyDescriptor(pair.publicKey)] });
    expect(keyring.getActive()).toEqual({ id: active.id, algorithm: "ES256", key: pair.privateKey });
    expect(keyring.resolve(active.id, "ES256")).toEqual({ id: active.id, algorithm: "ES256", key: pair.publicKey });
  });

  it.each([
    "EdDSA", "Ed25519", "ES256", "ES384", "ES512", "HS256", "HS384", "HS512",
    "PS256", "PS384", "PS512", "RS256", "RS384", "RS512",
  ] as const)("recognizes the explicitly supported %s key descriptor", (algorithm) => {
    // Key selection is independent of the crypto backend's later validation of key material.
    const descriptor = { id: "registered-key", algorithm, key: new Uint8Array(64) };
    const keyring = new JwtTokenKeyring({ active: descriptor, verification: [descriptor] });
    expect(keyring.resolve(descriptor.id, algorithm)).toEqual(descriptor);
  });

  it.each([undefined, null])("rejects missing signing material (%s) at construction", (key) => {
    // JavaScript callers can supply an incomplete key despite the TypeScript contract.
    expect(() => Reflect.construct(JwtTokenKeyring, [{
      active: { id: "current-key", algorithm: "ES256", key },
      verification: [],
    }])).toThrow('JWT key ID "current-key" requires key material');
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
  overrides: Pick<JwtTokenStrategyOptions, "clockToleranceSeconds" | "maximumTokenLifetimeSeconds"> = {},
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
