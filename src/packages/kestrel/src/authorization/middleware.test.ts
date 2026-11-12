import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthenticationContext } from "../authentication/index.js";
import { defineHttpAccessPolicy, defineHttpController, get, HttpControllerManager } from "../http/index.js";
import { MemorySubjectRoleStorageAdapter } from "./adapters/memory/index.js";
import { definePermission, defineRole } from "./definition.js";
import { requireAuthorization, requireHttpAuthorization } from "./middleware.js";
import { AuthorizationProvider } from "./provider.js";
import { defineSubjectRoleStorageAdapter, rolePermissions } from "./index.js";
import { AuthorizationDeniedError } from "./errors.js";
import { permission } from "./requirements.js";

describe("requireAuthorization", () => {
  it("protects an Action independently from its transport", async () => {
    const access = definePermission({ id: "records.write" });
    const store = new MemorySubjectRoleStorageAdapter();
    const writer = defineRole({ key: "writer", name: "Writer", permissions: [access] });
    await store.grantRole("subject-1", writer.key);
    const context = new AuthenticationContext<{}>();
    context.resolveAuthenticated({
      accountId: "account-1",
      subjectId: "subject-1",
      sessionId: "session-1",
      claims: {},
      authentication: {
        methods: ["password"],
        factors: ["knowledge"],
        authenticatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const handler = vi.fn(() => ({ saved: true }));
    const action = defineAction({
      name: "records.write",
      input: z.object({}),
      output: z.object({ saved: z.boolean() }),
      middleware: [requireAuthorization(permission(access))],
      handler,
    });
    const app = new App({});
    app.container.registerValue("authenticationContext", context);
    app.container.registerValue("subjectRoleStore", store);
    app.register(new AuthorizationProvider(rolePermissions([writer], defineSubjectRoleStorageAdapter({ dependencies: {}, capabilities: {}, create: () => store }))));

    try {
      await expect(app.get(action).run({})).resolves.toEqual({ saved: true });
      // A new execution sees revocation without invalidating the authenticated session.
      await store.revokeRole("subject-1", writer.key);
      const denied = app.get(action).run({});
      await expect(denied).rejects.toBeInstanceOf(AuthorizationDeniedError);
      await expect(denied).rejects.toMatchObject({
        name: "AuthorizationDeniedError",
        message: "Access is forbidden.",
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
  });

  it("returns a generic HTTP denial and keeps the protected handler outside denied requests", async () => {
    const access = definePermission({ id: "records.write" });
    const writer = defineRole({ key: "writer", name: "Writer", permissions: [access] });
    const store = new MemorySubjectRoleStorageAdapter();
    const context = new AuthenticationContext();
    context.resolveAuthenticated({
      accountId: "account-1",
      subjectId: "subject-1",
      sessionId: "session-1",
      claims: {},
      authentication: {
        methods: ["password"],
        factors: ["knowledge"],
        authenticatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const app = new App({});
    const server = Fastify();
    const handler = vi.fn(() => ({ saved: true }));

    try {
      app.container.registerValue("authenticationContext", context);
      app.register(new AuthorizationProvider(rolePermissions([writer], defineSubjectRoleStorageAdapter({
        dependencies: {}, capabilities: {}, create: () => store,
      }))));
      const manager = new HttpControllerManager(app, server);
      manager.register(defineHttpController({
        route: get("/protected"),
        access: defineHttpAccessPolicy("test.protected", [requireHttpAuthorization(permission(access))]),
        handler,
      }));
      server.addHook("onReady", async () => app.start());

      // The public failure exposes neither the role key nor the missing permission.
      const denied = await server.inject("/protected");
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ statusCode: 403, error: "Forbidden", message: "Access is forbidden." });
      expect(handler).not.toHaveBeenCalled();

      await store.grantRole("subject-1", writer.key);
      const granted = await server.inject("/protected");
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toEqual({ saved: true });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      try {
        await server.close();
      } finally {
        await app.dispose();
      }
    }
  });
});
