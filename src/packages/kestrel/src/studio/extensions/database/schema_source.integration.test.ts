import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { expect, it } from "vitest";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import { PostgresDatabaseSchemaSource } from "./schema_source.js";

it("reads ordered composite, self and cross-schema constraints from PostgreSQL", async () => {
  const pool = createPostgresTestPool();
  // Isolate catalog objects across parallel test processes and roll them all back.
  const suffix = randomUUID().replaceAll("-", "");
  const sourceSchema = `studio_source_${suffix}`;
  const targetSchema = `studio_target_${suffix}`;
  let client: PoolClient | undefined;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`
      CREATE SCHEMA ${sourceSchema};
      CREATE SCHEMA ${targetSchema};
      CREATE TABLE ${targetSchema}.team (
        tenant_id uuid NOT NULL, id uuid NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE ${sourceSchema}.member (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, team_id uuid NOT NULL,
        parent_id uuid REFERENCES ${sourceSchema}.member(id),
        CONSTRAINT team_fk FOREIGN KEY (team_id, tenant_id)
          REFERENCES ${targetSchema}.team(id, tenant_id)
      );
      CREATE TABLE ${sourceSchema}.marker ();
      COMMENT ON TABLE ${sourceSchema}.member IS 'Members & their teams.';
    `);
    const source = new PostgresDatabaseSchemaSource({ query: client.query.bind(client) });

    const layout = await source.getLayout();
    const schema = layout.schemas.find((entry) => entry.name === sourceSchema)!;
    const member = schema.tables.find((entry) => entry.name === "member")!;

    expect(member.description).toBe("Members & their teams.");
    expect(member.columns.map((column) => column.name)).toEqual(["id", "tenant_id", "team_id", "parent_id"]);
    expect(member.foreignKeys).toEqual([
      { name: "member_parent_id_fkey", columns: ["parent_id"], referencedSchema: sourceSchema, referencedTable: "member", referencedColumns: ["id"] },
      { name: "team_fk", columns: ["team_id", "tenant_id"], referencedSchema: targetSchema, referencedTable: "team", referencedColumns: ["id", "tenant_id"] },
    ]);
    expect(schema.tables.find((entry) => entry.name === "marker")?.columns).toEqual([]);
    expect(layout.schemas.some((entry) => entry.name.startsWith("pg_") || entry.name === "information_schema")).toBe(false);
  } finally {
    try {
      await client?.query("ROLLBACK");
    } finally {
      client?.release();
      await pool.end();
    }
  }
});
