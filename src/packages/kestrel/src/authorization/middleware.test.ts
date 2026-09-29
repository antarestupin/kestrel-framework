import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthenticationContext } from "../authentication/index.js";
import { MemoryAuthorizationAdapter } from "./adapters/memory/index.js";
import { definePermission, defineRole } from "./definition.js";
import { requireAuthorization } from "./middleware.js";
import { AuthorizationProvider } from "./provider.js";
import { permission } from "./requirements.js";

describe("requireAuthorization", () => {
  it("protects an Action independently from its transport", async () => {
    const access = definePermission({ id: "records.write" });
    const adapter = new MemoryAuthorizationAdapter({
      createId: () => "role-1",
      roles: [defineRole({
        key: "writer",
        name: "Writer",
        permissions: [access],
      })],
    });
    await adapter.grantRole("subject-1", "role-1");
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
    app.container.registerValue("permissionResolver", adapter);
    app.register(new AuthorizationProvider());

    await expect(app.get(action).run({})).resolves.toEqual({ saved: true });
    expect(handler).toHaveBeenCalledOnce();
    await app.dispose();
  });
});
