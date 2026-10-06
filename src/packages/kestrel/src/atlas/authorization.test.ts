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
import { MemoryAuthorizationAdapter } from "../authorization/adapters/memory/index.js";
import { definePermission, defineRole } from "../authorization/definition.js";
import { requireHttpAuthorization } from "../authorization/middleware.js";
import { AuthorizationProvider } from "../authorization/provider.js";
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
  const adapter = new MemoryAuthorizationAdapter({
    roles: [operatorRole],
    createId: () => "role-1",
  });

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
    await adapter.grantRole("subject-1", "role-1");
  }

  app.container.registerValue("authenticationContext", context);
  app.container.registerValue("permissionResolver", adapter);
  app.register(new AuthorizationProvider());
  app.register(new AtlasProvider({
    atlas: defineAtlas({ basePath: "/atlas", resources: [] }),
    client: new TestClient(),
    access: {
      required: [requireHttpAuthorization(permission(atlasAccess))],
    },
  }));

  for (const extension of app.httpExtensions.definitions) {
    await extension.mount({ app, server });
  }
  await app.start();

  const response = await server.inject({ method: "GET", url: "/atlas" });
  expect(response.statusCode).toBe(expectedStatus);

  await server.close();
  await app.dispose();
}
