import type { Pool } from "pg";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PostgresDatabaseSchemaSource } from "./schema_source.js";

describe("PostgresDatabaseSchemaSource", () => {
  it("groups catalog rows by schema and table while preserving column order", async () => {
    const query = vi.fn(async (_queryText: string) => ({
      rows: [
        {
          schema_name: "public",
          schema_description: "Shared application data.",
          table_name: "accounts",
          table_description: "User-facing accounts.",
          relation_kind: "r",
          column_position: 1,
          column_name: "id",
          column_description: "Stable account identifier.",
          column_type: "uuid",
          nullable: false,
          primary_key: true,
        },
        {
          schema_name: "public",
          schema_description: "Shared application data.",
          table_name: "accounts",
          table_description: "User-facing accounts.",
          relation_kind: "r",
          column_position: 2,
          column_name: "display_name",
          column_description: null,
          column_type: "text",
          nullable: true,
          primary_key: false,
        },
        {
          schema_name: "utils",
          schema_description: null,
          table_name: "events",
          table_description: null,
          relation_kind: "p",
          column_position: 1,
          column_name: "created_at",
          column_description: "Event creation time.",
          column_type: "timestamp with time zone",
          nullable: false,
          primary_key: true,
        },
      ],
    }));
    const source = new PostgresDatabaseSchemaSource({
      query,
    } as unknown as Pick<Pool, "query">);

    await expect(source.getLayout()).resolves.toEqual({
      schemas: [
        {
          name: "public",
          description: "Shared application data.",
          tables: [
            {
              name: "accounts",
              description: "User-facing accounts.",
              kind: "table",
              columns: [
                {
                  name: "id",
                  description: "Stable account identifier.",
                  type: "uuid",
                  nullable: false,
                  primaryKey: true,
                },
                {
                  name: "display_name",
                  type: "text",
                  nullable: true,
                  primaryKey: false,
                },
              ],
            },
          ],
        },
        {
          name: "utils",
          tables: [
            {
              name: "events",
              kind: "partitioned-table",
              columns: [
                {
                  name: "created_at",
                  description: "Event creation time.",
                  type: "timestamp with time zone",
                  nullable: false,
                  primaryKey: true,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "namespace.nspname !~ '^pg_'",
    );
    expect(query.mock.calls[0]?.[0]).toContain("pg_catalog.obj_description");
    expect(query.mock.calls[0]?.[0]).toContain("pg_catalog.col_description");
  });

  it("keeps PostgreSQL zero-column tables in the layout", async () => {
    const query = vi.fn(async (_queryText: string) => ({
      rows: [
        {
          schema_name: "public",
          schema_description: null,
          table_name: "marker",
          table_description: "A marker table.",
          relation_kind: "r",
          column_position: null,
          column_name: null,
          column_description: null,
          column_type: null,
          nullable: true,
          primary_key: false,
        },
      ],
    }));
    const source = new PostgresDatabaseSchemaSource({
      query,
    } as unknown as Pick<Pool, "query">);

    await expect(source.getLayout()).resolves.toEqual({
      schemas: [{
        name: "public",
        tables: [{
          name: "marker",
          description: "A marker table.",
          kind: "table",
          columns: [],
        }],
      }],
    });
  });
});
