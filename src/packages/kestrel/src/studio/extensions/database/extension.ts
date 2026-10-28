import { definition as faDatabase } from "@fortawesome/free-solid-svg-icons/faDatabase";
import { definition as faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons/faUpRightFromSquare";
import { z } from "zod";

import {
  defineHttpController,
  get,
} from "../../../http/index.js";
import type { StudioExtension } from "../../extension.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import { DATABASE_SCHEMA_PAGE_KIND } from "./contract.js";
import type { DatabaseSchemaSource } from "./schema_source.js";
import { renderDatabaseSchemaSvg } from "./schema_svg.js";

const databaseIcon = fontAwesomeIcon(faDatabase);
const externalLinkIcon = fontAwesomeIcon(faUpRightFromSquare);

export const DRIZZLE_STUDIO_EXTENSION_ID = "database";
export const DRIZZLE_STUDIO_URL = "https://local.drizzle.studio";

const databaseLayoutSchema = z.object({
  schemas: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    tables: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      kind: z.enum(["table", "partitioned-table"]),
      columns: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        type: z.string(),
        nullable: z.boolean(),
        primaryKey: z.boolean(),
      })).readonly(),
      foreignKeys: z.array(z.object({
        name: z.string(),
        columns: z.array(z.string()).readonly(),
        referencedSchema: z.string(),
        referencedTable: z.string(),
        referencedColumns: z.array(z.string()).readonly(),
      })).readonly().optional(),
    })).readonly(),
  })).readonly(),
});

/** Adds the native schema layout and the full Drizzle database browser. */
export function defineDatabaseStudioExtension(
  source: DatabaseSchemaSource,
  drizzleStudioUrl: string = DRIZZLE_STUDIO_URL,
): StudioExtension {
  const dataPath = "/api/extensions/database/schema" as const;

  return {
    id: DRIZZLE_STUDIO_EXTENSION_ID,
    title: "Database",
    icon: databaseIcon,
    description: "Inspect the PostgreSQL schema or browse local data with Drizzle Studio.",
    section: { id: "database", title: "Database", order: 40 },
    pages: [
      {
        id: "schema",
        title: "Database schema",
        path: "/database",
        description: "Tables, columns and descriptions grouped by PostgreSQL schema.",
        kind: DATABASE_SCHEMA_PAGE_KIND,
        icon: databaseIcon,
        dataPath,
        order: 10,
      },
    ],
    links: [createDrizzleStudioLink(drizzleStudioUrl)],
    defineHttpControllers({ basePath }) {
      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(joinStudioPath(basePath, dataPath)),
          description: "Return the PostgreSQL database layout visible to Studio.",
          output: databaseLayoutSchema,
          handler: () => source.getLayout(),
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(joinStudioPath(basePath, `${dataPath}.svg`)),
          description: "Render a compact SVG overview of tables grouped by PostgreSQL schema.",
          handler: async ({ reply }) => {
            const diagram = renderDatabaseSchemaSvg(await source.getLayout());
            // Send an image directly so opening the resource never returns a JSON string.
            reply.type("image/svg+xml; charset=utf-8");
            reply.header("content-disposition", 'inline; filename="database-schema.svg"');
            reply.header("cache-control", "no-store");
            return diagram;
          },
        }),
      ];
    },
  };
}

/**
 * Adds the separately hosted Drizzle Studio browser to the local workspace.
 */
export function defineDrizzleStudioExtension(
  url: string = DRIZZLE_STUDIO_URL,
): StudioExtension {
  return {
    id: DRIZZLE_STUDIO_EXTENSION_ID,
    title: "Database",
    icon: databaseIcon,
    description: "Browse and edit the local PostgreSQL database with Drizzle Studio.",
    section: { id: "database", title: "Database", order: 40 },
    pages: [],
    links: [createDrizzleStudioLink(url)],
  };
}

function createDrizzleStudioLink(url: string) {
  return {
    id: "drizzle-studio",
    title: "Drizzle Studio",
    description: "Opens the local database browser in a new tab.",
    href: url,
    icon: externalLinkIcon,
    order: 20,
  };
}
