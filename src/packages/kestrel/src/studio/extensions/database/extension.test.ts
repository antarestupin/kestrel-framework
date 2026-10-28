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
  it.each(["/_studio", "/developer/tools", "/"])("serves a fresh inline SVG under %s", async (basePath) => {
    const source: DatabaseSchemaSource = {
      getLayout: vi.fn(async () => ({ schemas: [{ name: "public", tables: [{
        name: "member", kind: "table" as const,
        columns: [
          { name: "id", type: "uuid", nullable: false, primaryKey: true },
          { name: "parent_id", type: "uuid", nullable: true, primaryKey: false },
        ],
        foreignKeys: [{ name: "parent_fk", columns: ["parent_id"], referencedSchema: "public", referencedTable: "member", referencedColumns: ["id"] }],
      }] }] })),
    };
    const server = Fastify();
    const app = new App({});
    const studio = new Studio({ basePath, extensions: [defineDatabaseStudioExtension(source)] });
    const manager = new HttpControllerManager(app, server);

    try {
      for (const controller of await studio.defineHttpControllers()) manager.register(controller);
      await app.start();
      const prefix = basePath === "/" ? "" : basePath;
      const json = await server.inject(`${prefix}/api/extensions/database/schema`);
      expect(json.statusCode).toBe(200);
      // The JSON contract must retain the foreign keys used by the diagram.
      expect(json.json().schemas[0].tables[0].foreignKeys[0].name).toBe("parent_fk");

      const response = await server.inject(`${prefix}/api/extensions/database/schema.svg`);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe('inline; filename="database-schema.svg"');
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatch(/^<\?xml/);
      expect(response.body).toContain("parent_fk: (parent_id) → public.member(id)");
      expect(response.body).toContain('class="database-schema-frame"');
      expect(response.body).not.toContain("marker-end=");
      expect(source.getLayout).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it("reports schema-source failures as errors instead of SVG content", async () => {
    const server = Fastify();
    const app = new App({});
    const studio = new Studio({ extensions: [defineDatabaseStudioExtension({
      getLayout: async () => { throw new Error("Catalog unavailable"); },
    })] });
    const manager = new HttpControllerManager(app, server);

    try {
      for (const controller of await studio.defineHttpControllers()) manager.register(controller);
      await app.start();
      const response = await server.inject("/_studio/api/extensions/database/schema.svg");
      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain("<svg");
    } finally {
      await server.close();
      await app.dispose();
    }
  });

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
