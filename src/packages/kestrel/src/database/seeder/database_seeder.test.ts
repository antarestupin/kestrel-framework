import { randomUUID } from "node:crypto";

import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  integer,
  pgSchema,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  type Pool,
  type PoolClient,
} from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createPostgresTestPool } from "../../testing/postgres.js";
import { defineDatabaseSeed } from "./definition.js";
import { seedDatabase } from "./database_seeder.js";

const seedGroups = pgTable("seeder_group", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  name: text("name").notNull(),
});
const seedMembers = pgTable("seeder_member", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  groupId: integer("group_id").notNull(),
  name: text("name").notNull(),
  joinedAt: timestamp("joined_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});
// Generated steps describe only the columns they insert, leaving defaults to PostgreSQL.
const groupInsertion = pgTable("seeder_group", { name: text().notNull() });
const memberInsertion = pgTable("seeder_member", {
  groupId: integer("group_id").notNull(),
  name: text().notNull(),
});

let pool: Pool;
let client: PoolClient;

beforeAll(() => {
  pool = createPostgresTestPool();
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query(`
    DROP TABLE IF EXISTS pg_temp.seeder_member;
    DROP TABLE IF EXISTS pg_temp.seeder_group;
    CREATE TEMPORARY TABLE seeder_group (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TEMPORARY TABLE seeder_member (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      group_id integer NOT NULL REFERENCES seeder_group(id),
      name text NOT NULL,
      joined_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

afterEach(() => {
  client.release();
});

afterAll(async () => {
  await pool.end();
});

describe("seedDatabase", () => {
  it("rejects duplicate step keys before accessing the database", async () => {
    const duplicateStep = {
      type: "records" as const,
      key: "groups",
      table: seedGroups,
      records: () => [],
    };

    await expect(seedDatabase({} as never, defineDatabaseSeed({
      steps: [duplicateStep, duplicateStep],
    }))).rejects.toThrow("Duplicate seed step 'groups'.");
  });

  it("resolves named records and shares the injected reference time", async () => {
    const database = drizzle(client);
    const now = new Date("2026-08-20T10:00:00.000Z");
    const definition = defineDatabaseSeed({
      steps: [
        {
          type: "records",
          key: "groups",
          table: seedGroups,
          records: () => [{
            key: "editors",
            values: { name: "Editors" },
          }],
        },
        {
          type: "records",
          key: "members",
          table: seedMembers,
          records: (context) => [{
            key: "sam",
            values: {
              name: "Sam",
              joinedAt: context.now,
            },
            references: {
              groupId: { step: "groups", record: "editors" },
            },
          }],
        },
      ],
    });

    await seedDatabase(database, definition, { now });

    const [group] = await database.select().from(seedGroups);
    const [member] = await database.select().from(seedMembers);

    expect(member).toMatchObject({
      groupId: group?.id,
      name: "Sam",
      joinedAt: now,
    });
  });

  it("rolls back every record when a named reference is invalid", async () => {
    const database = drizzle(client);
    const definition = defineDatabaseSeed({
      steps: [
        {
          type: "records",
          key: "groups",
          table: seedGroups,
          records: () => [{
            key: "editors",
            values: { name: "Editors" },
          }],
        },
        {
          type: "records",
          key: "members",
          table: seedMembers,
          records: ({ now }) => [{
            key: "sam",
            values: { name: "Sam", joinedAt: now },
            references: {
              groupId: { step: "groups", record: "missing" },
            },
          }],
        },
      ],
    });

    await expect(seedDatabase(database, definition)).rejects.toThrow(
      "Seed record 'members.sam' references unavailable record 'groups.missing'.",
    );
    await expect(database.select().from(seedGroups)).resolves.toEqual([]);
    await expect(database.select().from(seedMembers)).resolves.toEqual([]);
  });

  it("rejects non-empty target tables before inserting another step", async () => {
    const database = drizzle(client);
    await database.insert(seedGroups).values({ name: "Existing" });
    const definition = defineDatabaseSeed({
      steps: [{
        type: "records",
        key: "members",
        table: seedMembers,
        records: ({ now }) => [{
          key: "sam",
          values: { name: "Sam", groupId: 1, joinedAt: now },
        }],
      }, {
        type: "records",
        key: "groups",
        table: seedGroups,
        records: () => [{
          key: "editors",
          values: { name: "Editors" },
        }],
      }],
    });

    await expect(seedDatabase(database, definition)).rejects.toThrow(
      "Cannot seed non-empty table 'public.seeder_group'.",
    );
    await expect(database.select().from(seedMembers)).resolves.toEqual([]);
  });

  it("resolves record references by their exact step and alias even when names contain dots", async () => {
    const database = drizzle(client);
    await seedDatabase(database, defineDatabaseSeed({
      steps: [
        {
          type: "records", key: "group", table: seedGroups,
          records: () => [{ key: "team.core", values: { name: "First" } }],
        },
        {
          type: "records", key: "group.team", table: seedGroups,
          records: () => [{ key: "core", values: { name: "Second" } }],
        },
        {
          type: "records", key: "members", table: seedMembers,
          records: ({ now }) => [
            {
              key: "first", values: { name: "First member", joinedAt: now },
              references: { groupId: { step: "group", record: "team.core" } },
            },
            {
              key: "second", values: { name: "Second member", joinedAt: now },
              references: { groupId: { step: "group.team", record: "core" } },
            },
          ],
        },
      ],
    }));

    // Both aliases have the same dotted spelling when concatenated, but identify different rows.
    const groups = await database.select().from(seedGroups);
    const members = await database.select().from(seedMembers).orderBy(seedMembers.id);
    const groupById = new Map(groups.map(({ id, name }) => [id, name]));
    expect(members.map(({ name, groupId }) => [name, groupById.get(groupId)])).toEqual([
      ["First member", "First"], ["Second member", "Second"],
    ]);
  });

  it("checks both tables for existing rows when schema and table names contain dots", async () => {
    const database = drizzle(client);
    const schema = `seed_${randomUUID().replaceAll("-", "")}`;
    const nested = `${schema}.nested`;
    const empty = pgSchema(schema).table("nested.group", { id: integer().primaryKey() });
    const populated = pgSchema(nested).table("group", { id: integer().primaryKey() });
    const records = () => [{ key: "new", values: { id: 2 } }];
    const definition = defineDatabaseSeed({
      steps: [
        { type: "records", key: "empty", table: empty, records },
        { type: "records", key: "populated", table: populated, records },
      ],
    });

    // Roll back the test-owned schemas without modifying other integration fixtures.
    await database.transaction(async (tx) => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(nested)}`);
      await tx.execute(sql`CREATE TABLE ${sql.identifier(schema)}.${sql.identifier("nested.group")} (id integer PRIMARY KEY)`);
      await tx.execute(sql`CREATE TABLE ${sql.identifier(nested)}.${sql.identifier("group")} (id integer PRIMARY KEY)`);
      await tx.insert(populated).values({ id: 1 });

      await expect(seedDatabase(tx, definition, { transaction: false }))
        .rejects.toThrow("Cannot seed non-empty table");
      await expect(tx.select().from(empty)).resolves.toEqual([]);
      await expect(tx.select().from(populated)).resolves.toEqual([{ id: 1 }]);
      tx.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  });

  it.each([{}, { seed: 42, version: "2" as const }])("seeds generated rows with database identities (%j)", async (settings) => {
    const database = drizzle(client);
    await seedDatabase(database, defineDatabaseSeed({
      ...settings,
      steps: [
        { key: "groups", table: seedGroups, insertionTable: groupInsertion, count: 1 },
        {
          key: "members", table: seedMembers, identity: seedMembers.id, insertionTable: memberInsertion, count: 2,
          references: { groupId: "groups" },
          columns: (generators) => ({ name: generators.valuesFromArray({ values: ["Generated member"] }) }),
        },
      ],
    }));

    const groups = await database.select().from(seedGroups);
    const members = await database.select().from(seedMembers).orderBy(seedMembers.id);
    expect(groups).toEqual([{ id: 1, name: expect.any(String) }]);
    // The generated foreign keys use the identity returned by the database, not the seed index.
    expect(members).toEqual([1, 2].map((id) => ({
      id, groupId: groups[0]!.id, name: "Generated member", joinedAt: expect.any(Date),
    })));
  });

  it.each(["missing", "empty"])("rejects a generated reference to a %s step", async (reference) => {
    const database = drizzle(client);
    await expect(seedDatabase(database, defineDatabaseSeed({
      steps: [
        { type: "records", key: "empty", table: seedGroups, records: () => [] },
        {
          key: "members", table: seedMembers, insertionTable: memberInsertion, count: 1,
          references: { groupId: reference },
        },
      ],
    }))).rejects.toThrow(`Seed step 'members' references unavailable step '${reference}'.`);
    await expect(database.select().from(seedMembers)).resolves.toEqual([]);
  });

  it("rejects a target with no declared or conventional identity before inserting records", async () => {
    const database = drizzle(client);
    await expect(seedDatabase(database, defineDatabaseSeed({
      steps: [{
        type: "records", key: "groups", table: groupInsertion,
        records: () => [{ key: "group", values: { name: "Group" } }],
      }],
    }))).rejects.toThrow("Seed step 'groups' must declare an identity column.");
    await expect(database.select().from(seedGroups)).resolves.toEqual([]);
  });

  it("still rejects duplicate aliases in one step and rolls back the earlier insert", async () => {
    const database = drizzle(client);
    await expect(seedDatabase(database, defineDatabaseSeed({
      steps: [{
        type: "records", key: "groups", table: seedGroups,
        records: () => [
          { key: "duplicate", values: { name: "First" } },
          { key: "duplicate", values: { name: "Second" } },
        ],
      }],
    }))).rejects.toThrow("Duplicate seed record 'groups.duplicate'.");
    await expect(database.select().from(seedGroups)).resolves.toEqual([]);
  });

  it("rolls back the seed when a database trigger suppresses an insert", async () => {
    const database = drizzle(client);
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.skip_seed_record() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_record BEFORE INSERT ON pg_temp.seeder_group
        FOR EACH ROW WHEN (NEW.name = 'Ignored') EXECUTE FUNCTION pg_temp.skip_seed_record();
    `);

    // A skipped row provides no identity to downstream seed steps.
    await expect(seedDatabase(database, defineDatabaseSeed({
      steps: [{
        type: "records", key: "groups", table: seedGroups,
        records: () => [
          { key: "first", values: { name: "First" } },
          { key: "ignored", values: { name: "Ignored" } },
        ],
      }],
    }))).rejects.toThrow("Seed record 'groups.ignored' returned no identity.");
    await expect(database.select().from(seedGroups)).resolves.toEqual([]);
  });
});
