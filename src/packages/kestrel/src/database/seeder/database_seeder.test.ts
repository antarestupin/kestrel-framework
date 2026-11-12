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
  vi,
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

  it.each(["records", "generated"] as const)(
    "resolves generated references only to identities from their named step after a %s step",
    async (firstStep) => {
      const database = drizzle(client);
      await seedDatabase(database, defineDatabaseSeed({
        seed: 42,
        steps: [
          firstStep === "records"
            ? { type: "records", key: "firstGroup", table: seedGroups, records: () => [
              { key: "first", values: { name: "First" } },
            ] }
            : {
              key: "firstGroup", table: seedGroups, insertionTable: groupInsertion, count: 1,
              columns: (generators) => ({ name: generators.valuesFromArray({ values: ["First"] }) }),
            },
          { key: "generated", table: seedGroups, insertionTable: groupInsertion, count: 1 },
          {
            key: "generatedMembers", table: seedMembers, insertionTable: memberInsertion, count: 12,
            references: { groupId: "generated" },
            columns: (generators) => ({ name: generators.valuesFromArray({ values: ["Generated"] }) }),
          },
          {
            key: "curatedMembers", table: seedMembers, insertionTable: memberInsertion, count: 1,
            references: { groupId: "firstGroup" },
            columns: (generators) => ({ name: generators.valuesFromArray({ values: ["First"] }) }),
          },
        ],
      }));

      // The groups share a table, but their reference sets stay separate.
      const groups = await database.select().from(seedGroups).orderBy(seedGroups.id);
      const members = await database.select().from(seedMembers).orderBy(seedMembers.id);
      expect(groups).toHaveLength(2);
      expect(groups[0]?.name).toBe("First");
      expect(members).toHaveLength(13);
      expect(members.filter(({ name }) => name === "Generated").map(({ groupId }) => groupId))
        .toEqual(Array.from({ length: 12 }, () => groups[1]!.id));
      expect(members.filter(({ name }) => name === "First").map(({ groupId }) => groupId))
        .toEqual([groups[0]!.id]);
    },
  );

  it("compares decoded non-primitive seed identities by value", async () => {
    const database = drizzle(client);
    const calendar = pgTable("seeder_calendar", {
      id: timestamp("id", { withTimezone: true, mode: "date" }).primaryKey(),
      name: text().notNull(),
    });
    const calendarInsertion = pgTable("seeder_calendar", { name: text().notNull() });
    const memberWithDate = pgTable("seeder_member", {
      groupId: integer("group_id").notNull(),
      name: text().notNull(),
      joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
    });
    const curated = new Date("2026-01-01T00:00:00Z");
    const generated = new Date("2026-02-01T00:00:00Z");
    await client.query(`
      DROP TABLE IF EXISTS pg_temp.seeder_calendar;
      CREATE TEMPORARY TABLE seeder_calendar (
        id timestamptz PRIMARY KEY DEFAULT '2026-02-01T00:00:00Z',
        name text NOT NULL
      )
    `);
    await seedDatabase(database, defineDatabaseSeed({
      seed: 42,
      steps: [
        { type: "records", key: "group", table: seedGroups, records: () => [
          { key: "first", values: { name: "Group" } },
        ] },
        { type: "records", key: "curatedDates", table: calendar, records: () => [
          { key: "first", values: { id: curated, name: "Curated" } },
          { key: "second", values: { id: new Date("2026-01-02T00:00:00Z"), name: "Other curated" } },
        ] },
        { key: "generatedDates", table: calendar, insertionTable: calendarInsertion, count: 1 },
        {
          key: "members", table: seedMembers, insertionTable: memberWithDate, count: 12,
          references: { groupId: "group", joinedAt: "generatedDates" },
        },
      ],
    }));

    // PostgreSQL returns distinct Date objects for the same pre-existing identity.
    const members = await database.select().from(seedMembers);
    expect(members.map(({ joinedAt }) => joinedAt)).toEqual(Array.from({ length: 12 }, () => generated));
  });

  it("excludes rows a prior step's trigger inserted into the generated target", async () => {
    const database = drizzle(client);
    const initializer = pgTable("seeder_initializer", { id: integer().primaryKey() });
    await database.transaction(async (tx) => {
      // The target is empty at preflight, but this other table can populate it before generation.
      await tx.execute(sql.raw(`
        CREATE TEMPORARY TABLE seeder_initializer (id integer PRIMARY KEY);
        CREATE FUNCTION pg_temp.seeder_fill_group() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO pg_temp.seeder_group (name) VALUES ('Trigger-created group');
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER seeder_fill_group AFTER INSERT ON seeder_initializer
          FOR EACH ROW EXECUTE FUNCTION pg_temp.seeder_fill_group();
      `));
      await seedDatabase(tx, defineDatabaseSeed({
        seed: 42,
        steps: [
          { type: "records", key: "init", table: initializer, records: () => [{ key: "init", values: { id: 1 } }] },
          { key: "generated", table: seedGroups, insertionTable: groupInsertion, count: 1 },
          {
            key: "members", table: seedMembers, insertionTable: memberInsertion, count: 12,
            references: { groupId: "generated" },
          },
        ],
      }), { transaction: false });

      const groups = await tx.select().from(seedGroups).orderBy(seedGroups.id);
      expect(groups).toHaveLength(2);
      expect(groups[0]?.name).toBe("Trigger-created group");
      const members = await tx.select().from(seedMembers);
      expect(members.map(({ groupId }) => groupId)).toEqual(Array.from({ length: 12 }, () => groups[1]!.id));
      tx.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  });

  it("uses the supplied generator version and seed reproducibly", async () => {
    const database = drizzle(client);
    const generate = async (seed: number, version: "1" | "2") => {
      await client.query("TRUNCATE pg_temp.seeder_member, pg_temp.seeder_group RESTART IDENTITY");
      await seedDatabase(database, defineDatabaseSeed({
        seed,
        version,
        steps: [{
          key: "groups", table: seedGroups, insertionTable: groupInsertion, count: 4,
          columns: (generators) => ({ name: generators.string({ isUnique: true }) }),
        }],
      }));
      return database.select().from(seedGroups).orderBy(seedGroups.id);
    };

    const original = await generate(11, "1");
    expect(await generate(11, "1")).toEqual(original);
    expect(await generate(12, "1")).not.toEqual(original);
    expect(await generate(11, "2")).not.toEqual(original);
  });

  it("honors an existing transaction without creating a nested savepoint", async () => {
    const database = drizzle(client);
    await expect(database.transaction(async (transaction) => {
      const nested = vi.spyOn(transaction, "transaction");
      await seedDatabase(transaction, defineDatabaseSeed({
        steps: [{
          type: "records", key: "groups", table: seedGroups,
          records: () => [{ key: "first", values: { name: "Owned by caller" } }],
        }],
      }), { transaction: false });
      expect(nested).not.toHaveBeenCalled();
      await expect(transaction.select().from(seedGroups)).resolves.toMatchObject([{ name: "Owned by caller" }]);
      transaction.rollback();
    })).rejects.toBeInstanceOf(TransactionRollbackError);
    await expect(database.select().from(seedGroups)).resolves.toEqual([]);
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
