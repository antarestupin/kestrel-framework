import { drizzle } from "drizzle-orm/node-postgres";
import {
  integer,
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

let pool: Pool;
let client: PoolClient;

beforeAll(() => {
  pool = createPostgresTestPool();
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query(`
    DROP TABLE IF EXISTS seeder_member;
    DROP TABLE IF EXISTS seeder_group;
    CREATE TEMPORARY TABLE seeder_group (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TEMPORARY TABLE seeder_member (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      group_id integer NOT NULL REFERENCES seeder_group(id),
      name text NOT NULL,
      joined_at timestamp with time zone NOT NULL
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
});
