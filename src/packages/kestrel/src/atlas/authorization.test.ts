import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { describe, expect, it } from "vitest";

import { App } from "../app/index.js";
import { AuthenticationContext } from "../authentication/index.js";
import {
  type Atlas,
  type AtlasClientAdapter,
  type AtlasClientRender,
  AtlasProvider,
  defineAtlas,
} from "./index.js";
import { MemorySubjectRoleStore } from "../authorization/adapters/memory/index.js";
import { definePermission, defineRole } from "../authorization/definition.js";
import { requireHttpAuthorization } from "../authorization/middleware.js";
import { AuthorizationProvider } from "../authorization/provider.js";
import { RolePermissionResolverProvider } from "../authorization/resolvers/roles/index.js";
import { permission } from "../authorization/requirements.js";

class TestClient implements AtlasClientAdapter {
  public async setup(
    _server: FastifyInstance,
    _atlas: Atlas,
  ): Promise<AtlasClientRender> {
    return (reply: FastifyReply) => reply.type("text/html").send("atlas shell");
  }
}

const atlasAccess = definePermission({ id: "atlas.access" });
const operatorRole = defineRole({
  key: "operator",
  name: "Operator",
  permissions: [atlasAccess],
});

describe("atlas authorization integration", () => {
  it("returns 401 anonymously, 403 without permission, and allows an operator", async () => {
    await expectAccess("anonymous", 401);
    await expectAccess("authenticated", 403);
    await expectAccess("operator", 200);
  });
});

async function expectAccess(
  state: "anonymous" | "authenticated" | "operator",
  expectedStatus: number,
): Promise<void> {
  const server = Fastify();
  const app = new App({});
  const context = new AuthenticationContext<{}>();
  const store = new MemorySubjectRoleStore();

  if (state === "anonymous") {
    context.resolveAnonymous();
  } else {
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
  }

  if (state === "operator") {
    await store.grantRole("subject-1", operatorRole.key);
  }

  app.container.registerValue("authenticationContext", context);
  app.container.registerValue("subjectRoleStore", store);
  app.register(new RolePermissionResolverProvider([operatorRole]));
  app.register(new AuthorizationProvider());
  app.register(new AtlasProvider({
    atlas: defineAtlas({ basePath: "/atlas", resources: [] }),
    client: new TestClient(),
    access: {
      required: [requireHttpAuthorization(permission(atlasAccess))],
    },
  }));

  try {
    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server });
    }
    await app.start();

    const response = await server.inject({ method: "GET", url: "/atlas" });
    expect(response.statusCode).toBe(expectedStatus);
  } finally {
    await server.close();
    await app.dispose();
  }
}
