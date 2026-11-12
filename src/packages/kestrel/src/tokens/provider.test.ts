import { memoryTokens } from "./index.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { defineTokenStorageAdapter } from "./adapter_definition.js";
import { MemoryTokenStorageAdapter } from "./adapters/memory/index.js";
import { tokensConfigBase, type TokensConfig } from "./configuration.js";
import { defineToken } from "./definition.js";
import { tokenManagerDependency, tokenStoreDependency } from "./dependencies.js";
import { TokenProvider } from "./provider.js";
import type { TokenStrategy } from "./types.js";

const config: TokensConfig = {
  stored: { tokenBytes: 32, maxPayloadBytes: 1_024 },
};

let app: App<Record<string, never>> | undefined;

afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

describe("tokens configuration", () => {
  it("supplies secure defaults and coerces explicit integer settings", () => {
    expect(tokensConfigBase.schema.parse({ stored: {} })).toStrictEqual({
      stored: { tokenBytes: 32, maxPayloadBytes: 4_096 },
    });
    expect(tokensConfigBase.schema.parse({
      stored: { tokenBytes: "48", maxPayloadBytes: "1024" },
    })).toStrictEqual({ stored: { tokenBytes: 48, maxPayloadBytes: 1_024 } });
    expect(tokensConfigBase.schema.safeParse({
      stored: { tokenBytes: 31, maxPayloadBytes: 1_024 },
    }).success).toBe(false);
  });
});

describe("TokenProvider", () => {
  it("rejects enabling the default stored strategy without a storage adapter", () => {
    const application = app = new App({});
    expect(() => application.register(new TokenProvider(config, undefined)))
      .toThrow("Stored token strategies require a token storage adapter");
  });

  it("issues and verifies a token using only the bundled stored strategy", async () => {
    const definition = defineToken({ name: "member.invitation", payload: z.string() });
    app = new App({});
    app.register(new TokenProvider(config, memoryTokens(new MemoryTokenStorageAdapter())));
    const tokens = app.container.resolve(tokenManagerDependency);

    // A plain provider still wires the configured store when no custom factories are present.
    const grant = await tokens.issue(definition, "member-1", { ttlSeconds: 60 });
    await expect(tokens.verify(definition, grant.token)).resolves.toBe("member-1");
  });

  it("composes a signed-only strategy without requiring a token store", async () => {
    const signed = {
      capabilities: {
        pruning: false,
        revocation: false,
        singleUse: false,
        subjectDeletion: false,
      },
      issue: async () => [
        {
          token: "signed-token",
          expiresAt: new Date("2026-01-01T00:01:00.000Z"),
        },
      ],
      verify: async () => ({
        payload: { memberId: "member-1" },
        expiresAt: new Date("2026-01-01T00:01:00.000Z"),
      }),
    } satisfies TokenStrategy;
    const definition = defineToken({
      name: "member.lookup",
      payload: z.object({ memberId: z.string() }),
      strategy: "jwt",
    });

    app = new App({});
    app.register(
      new TokenProvider(config, undefined, {
        stored: false,
        strategies: { jwt: signed },
      }),
    );
    const tokens = app.container.resolve(tokenManagerDependency);

    await expect(tokens.verify(definition, "signed-token")).resolves.toEqual({
      memberId: "member-1",
    });
  });

  it.each([true, false])("scopes managers and resolves stores only when needed (stored: %s)", async (stored) => {
    const createStore = vi.fn(() => new MemoryTokenStorageAdapter());
    app = new App({});
    app.register(new TokenProvider(config, defineTokenStorageAdapter({
      dependencies: {},
      capabilities: {},
      create: createStore,
    }), { stored }));
    const first = app.container.createScope();
    const second = app.container.createScope();
    try {
      expect(createStore).not.toHaveBeenCalled();
      const firstManager = first.resolve(tokenManagerDependency);
      expect(first.resolve(tokenManagerDependency)).toBe(firstManager);
      expect(second.resolve(tokenManagerDependency)).not.toBe(firstManager);
      expect(createStore).toHaveBeenCalledTimes(stored ? 2 : 0);

      // Resolving the public store dependency reuses the existing store within that execution.
      const firstStore = first.resolve(tokenStoreDependency);
      expect(first.resolve(tokenStoreDependency)).toBe(firstStore);
      expect(second.resolve(tokenStoreDependency)).not.toBe(firstStore);
      expect(createStore).toHaveBeenCalledTimes(2);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it("builds a hybrid strategy from the configured token store", async () => {
    const store = new MemoryTokenStorageAdapter();
    const hybrid = {
      capabilities: {
        pruning: true,
        revocation: true,
        singleUse: true,
        subjectDeletion: true,
      },
      issue: async () => [],
      verify: async () => ({
        payload: { memberId: "member-1" },
        expiresAt: new Date("2026-01-01T00:01:00.000Z"),
      }),
    } satisfies TokenStrategy;
    const definition = defineToken({
      name: "member.hybrid-lookup",
      payload: z.object({ memberId: z.string() }),
      strategy: "hybrid",
    });

    app = new App({});
    app.container.registerValue("tokenStore", store);
    app.register(
      new TokenProvider(config, memoryTokens(store), {
        stored: false,
        strategyFactories: {
          hybrid: (configuredStore) => {
            expect(configuredStore).toBe(store);
            return hybrid;
          },
        },
      }),
    );
    const tokens = app.container.resolve(tokenManagerDependency);

    await expect(tokens.verify(definition, "hybrid-token")).resolves.toEqual({
      memberId: "member-1",
    });
    // Retaining a store for a hybrid strategy must not enable the disabled opaque strategy.
    const opaque = defineToken({ name: "member.opaque-lookup", payload: z.string() });
    await expect(tokens.issue(opaque, "member-1", { ttlSeconds: 60 }))
      .rejects.toThrow('strategy "stored" required by "member.opaque-lookup" is not registered');
  });
});
