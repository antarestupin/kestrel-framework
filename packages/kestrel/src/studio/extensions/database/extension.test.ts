import Fastify from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import { Studio } from "../../studio.js";
import {
  defineDatabaseStudioExtension,
  defineDrizzleStudioExtension,
  DRIZZLE_STUDIO_URL,
} from "./extension.js";
import type { DatabaseSchemaSource } from "./schema_source.js";

describe("defineDrizzleStudioExtension", () => {
  it("links the database workspace to the separately hosted browser", () => {
    expect(defineDrizzleStudioExtension()).toEqual({
      id: "database",
      title: "Database",
      icon: expect.objectContaining({ type: "svg" }),
      description: "Browse and edit the local PostgreSQL database with Drizzle Studio.",
      section: { id: "database", title: "Database", order: 40 },
      pages: [],
      links: [
        {
          id: "drizzle-studio",
          title: "Drizzle Studio",
          description: "Opens the local database browser in a new tab.",
          href: DRIZZLE_STUDIO_URL,
          icon: expect.objectContaining({ type: "svg" }),
          order: 20,
        },
      ],
    });
  });

  it("accepts a provider-owned URL override", () => {
    const extension = defineDrizzleStudioExtension(
      "https://local.drizzle.studio?port=4984",
    );

    expect(extension.links?.[0]?.href).toBe(
      "https://local.drizzle.studio?port=4984",
    );
  });
});

describe("defineDatabaseStudioExtension", () => {
  it("exposes the native schema page and its catalog endpoint", async () => {
    const source: DatabaseSchemaSource = {
      getLayout: vi.fn<DatabaseSchemaSource["getLayout"]>(async () => ({
        schemas: [{
          name: "public",
          description: "Shared application data.",
          tables: [{
            name: "users",
            description: "Registered users.",
            kind: "table",
            columns: [{
              name: "id",
              description: "Stable user identifier.",
              type: "uuid",
              nullable: false,
              primaryKey: true,
            }],
          }],
        }],
      })),
    };
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDatabaseStudioExtension(source)],
    });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/database/schema",
    });

    expect(studio.getManifest().extensions[0]).toMatchObject({
      id: "database",
      pages: [{
        id: "schema",
        path: "/database",
        kind: "database-schema",
        dataPath: "/_studio/api/extensions/database/schema",
      }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemas: [{
        name: "public",
        description: "Shared application data.",
        tables: [{
          name: "users",
          description: "Registered users.",
          kind: "table",
          columns: [{
            name: "id",
            description: "Stable user identifier.",
            type: "uuid",
            nullable: false,
            primaryKey: true,
          }],
        }],
      }],
    });
    expect(source.getLayout).toHaveBeenCalledOnce();

    await server.close();
    await app.dispose();
  });
});
