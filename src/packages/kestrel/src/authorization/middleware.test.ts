import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthenticationContext } from "../authentication/index.js";
import { MemorySubjectRoleStore } from "./adapters/memory/index.js";
import { definePermission, defineRole } from "./definition.js";
import { requireAuthorization } from "./middleware.js";
import { AuthorizationProvider } from "./provider.js";
import { RolePermissionResolverProvider } from "./resolvers/roles/index.js";
import { AuthorizationDeniedError } from "./errors.js";
import { permission } from "./requirements.js";

describe("requireAuthorization", () => {
  it("protects an Action independently from its transport", async () => {
    const access = definePermission({ id: "records.write" });
    const store = new MemorySubjectRoleStore();
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
    app.register(new RolePermissionResolverProvider([writer]));
    app.register(new AuthorizationProvider());

    try {
      await expect(app.get(action).run({})).resolves.toEqual({ saved: true });
      // A new execution sees revocation without invalidating the authenticated session.
      await store.revokeRole("subject-1", writer.key);
      await expect(app.get(action).run({})).rejects.toBeInstanceOf(AuthorizationDeniedError);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
  });
});
