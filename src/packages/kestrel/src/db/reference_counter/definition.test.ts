import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bigint, boolean, foreignKey, integer, pgSchema, pgTable, primaryKey, smallint, text, uuid, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { getDatabaseSchemaContributions } from "../schema_contributions/definition.js";
import { createMigrationSqlPlan } from "../schema_contributions/migration_generator.js";
import { defineReferenceCounter, getReferenceCounterDefinitions } from "./definition.js";

function tables() {
  const parent = pgTable("parent", {
    id: integer("id").primaryKey(), count: integer("count").notNull().default(0),
  });
  const child = pgTable("child", {
    id: integer("id").primaryKey(), parentId: integer("parent_id").references(() => parent.id),
    status: text("status"), deletedAt: text("deleted_at"),
  });
  return { parent, child };
}

describe("reference counter definitions", () => {
  it("discovers source metadata without changing enumerable Drizzle exports", () => {
    const { parent, child } = tables();
    const keys = Object.keys(child);
    const definition = defineReferenceCounter(child, {
      id: "parent.count", reference: child.parentId, target: parent.id, counter: parent.count,
      where: (row) => and(eq(row.status, "published' $counter$"), isNull(row.deletedAt)),
    });
    expect(Object.keys(child)).toEqual(keys);
    expect(getReferenceCounterDefinitions({ copy: { ...child } })).toEqual([]);
    expect(getReferenceCounterDefinitions({ child, alias: child, definition })).toEqual([definition]);
    expect(definition.predicates.old).toContain('"old"."status"');
    expect(definition.predicates.new).toContain('"new"."deleted_at"');
    const [contribution] = getDatabaseSchemaContributions({ child });
    expect(contribution?.installSql).toContain("published'''' $counter$");
    expect(contribution?.installSql).not.toContain("$1");
    expect(contribution?.installSql).not.toContain("count(*)");
    expect(createMigrationSqlPlan([], [contribution!]).after).toEqual([contribution!.installSql]);
    expect(createMigrationSqlPlan([contribution!], []).before).toEqual([contribution!.uninstallBeforeSql]);
  });

  it("replaces triggers when a filter changes, without performing a baseline", () => {
    const create = (status: string) => {
      const { parent, child } = tables();
      defineReferenceCounter(child, { id: "count", reference: child.parentId, target: parent.id, counter: parent.count, where: (row) => eq(row.status, status) });
      return getDatabaseSchemaContributions({ child });
    };
    const previous = create("draft");
    const next = create("published");
    expect(createMigrationSqlPlan(previous, next)).toEqual({ before: [previous[0]!.uninstallBeforeSql], after: [next[0]!.updateSql] });
  });

  it("rejects foreign references, closed-over filter columns and duplicate ids", () => {
    const { parent, child } = tables();
    const options = { id: "count", reference: child.parentId, target: parent.id, counter: parent.count };
    // @ts-expect-error A reference from another table also fails the public type contract.
    expect(() => defineReferenceCounter(child, { ...options, reference: parent.id })).toThrow("reference column");
    expect(() => defineReferenceCounter(child, { ...options, where: () => eq(child.status, "published") })).toThrow("supplied source columns");
    expect(() => defineReferenceCounter(child, { ...options, where: (row) => eq(row.status, sql.placeholder("status")) })).toThrow("placeholders");
    defineReferenceCounter(child, options);
    expect(() => defineReferenceCounter(child, options)).toThrow("Duplicate");
    const other = tables();
    defineReferenceCounter(other.child, { id: "count", reference: other.child.parentId, target: other.parent.id, counter: other.parent.count });
    expect(() => getReferenceCounterDefinitions({ child, other: other.child })).toThrow("Duplicate");
  });

  it("validates primary keys, counter ownership, nullability and zero defaults", () => {
    const { child } = tables();
    const invalid = pgTable("invalid", {
      id: integer("id"), count: integer("count").notNull().default(0),
    });
    const invalidChild = pgTable("invalid_child", { parentId: integer("parent_id").references(() => invalid.id) });
    expect(() => defineReferenceCounter(invalidChild, { id: "count", reference: invalidChild.parentId, target: invalid.id, counter: invalid.count })).toThrow("primary key");
    const parent = pgTable("parent", {
      id: integer("id").primaryKey(), nullable: integer("nullable").default(0), nonzero: integer("nonzero").notNull().default(1),
    });
    const validChild = pgTable("valid_child", { parentId: integer("parent_id").references(() => parent.id) });
    expect(() => defineReferenceCounter(validChild, { id: "count", reference: validChild.parentId, target: parent.id, counter: parent.nullable })).toThrow("NOT NULL");
    expect(() => defineReferenceCounter(validChild, { id: "count", reference: validChild.parentId, target: parent.id, counter: parent.nonzero })).toThrow("zero");
    expect(() => defineReferenceCounter(child, { id: "count", reference: child.parentId, target: parent.id, counter: parent.nullable })).toThrow("foreign key");
  });

  it("accepts a table-level single primary key and SQL zero default", () => {
    const parent = pgTable("parent", {
      id: integer("id").notNull(), count: integer("count").notNull().default(sql`0`),
    }, (row) => [primaryKey({ columns: [row.id] })]);
    const child = pgTable("child", { parentId: integer("parent_id").references(() => parent.id), status: text("status") });
    const options = { reference: child.parentId, target: parent.id, counter: parent.count };
    expect(() => defineReferenceCounter(child, { ...options, id: " " })).toThrow("requires a stable id");
    expect(() => defineReferenceCounter(child, { ...options, id: "invalid", where: () => inArray(child.status, ["ready"]) }))
      .toThrow("supplied source columns");

    // The supported predicate reads only supplied columns and embeds its constant list.
    const definition = defineReferenceCounter(child, { ...options, id: "parent.count", where: (row) => inArray(row.status, ["ready", "done"]) });
    expect(definition.predicates.source).toBe(`"source"."status" in ('ready', 'done')`);
  });

  it("rejects foreign-key types that cannot drive an ordered rebuild cursor", () => {
    const parent = pgTable("parent", { id: boolean("id").primaryKey(), count: integer("count").notNull().default(0) });
    const child = pgTable("child", { parentId: boolean("parent_id").references(() => parent.id) });
    expect(() => defineReferenceCounter(child, {
      id: "parent.count", reference: child.parentId, target: parent.id, counter: parent.count,
    })).toThrow("must have matching UUID, text or integer SQL types");
  });

  it("quotes physical identifiers including schemas and table names containing dots", () => {
    const schema = pgSchema('odd.schema"');
    const parent = schema.table('parent.name"', { id: integer('key"').primaryKey(), count: integer('count"').notNull().default(0) });
    const child = schema.table('child.name"', { parent: integer('ref"').references(() => parent.id) });
    defineReferenceCounter(child, { id: "a".repeat(100), reference: child.parent, target: parent.id, counter: parent.count });
    const [contribution] = getDatabaseSchemaContributions({ child });
    expect(contribution!.installSql).toContain('"odd.schema"""."parent.name"""');
    expect(contribution!.uninstallBeforeSql).toContain('DROP FUNCTION IF EXISTS "odd.schema"""."__counter_');
  });

  it("rejects composite or mismatched keys before installing a trigger", () => {
    const parent = pgTable("parent", {
      id: integer("id").notNull(), secondId: integer("second_id").notNull(), count: integer("count").notNull().default(0),
    }, (row) => [primaryKey({ columns: [row.id, row.secondId] })]);
    const child = pgTable("child", { parentId: integer("parent_id").references(() => parent.id) });
    expect(() => defineReferenceCounter(child, {
      id: "composite.count", reference: child.parentId, target: parent.id, counter: parent.count,
    })).toThrow("single-column primary key");

    const singleParent = pgTable("single_parent", {
      id: integer("id").primaryKey(), count: integer("count").notNull().default(0),
    });
    const mismatchedChild = pgTable("mismatched_child", { parentId: text("parent_id").references(() => singleParent.id) });
    expect(() => defineReferenceCounter(mismatchedChild, {
      id: "mismatch.count", reference: mismatchedChild.parentId, target: singleParent.id, counter: singleParent.count,
    })).toThrow("matching UUID, text or integer SQL types");
  });

  it("deduplicates exports, orders counters by id, and rejects physical destination conflicts", () => {
    const first = tables();
    const last = tables();
    const a = defineReferenceCounter(first.child, {
      id: "a", reference: first.child.parentId, target: first.parent.id, counter: first.parent.count,
    });
    const z = defineReferenceCounter(last.child, {
      id: "z", reference: last.child.parentId, target: last.parent.id, counter: last.parent.count,
    });
    expect(() => getReferenceCounterDefinitions({ a: first.child, z: last.child })).toThrow('Duplicate reference counter id or destination: "z".');

    const other = pgTable("other_parent", {
      id: integer("id").primaryKey(), count: integer("count").notNull().default(0),
      duplicateCount: integer("duplicate_count").notNull().default(0),
    });
    const otherChild = pgTable("other_child", { parentId: integer("parent_id").references(() => other.id) });
    const b = defineReferenceCounter(otherChild, { id: "b", reference: otherChild.parentId, target: other.id, counter: other.count });
    expect(getReferenceCounterDefinitions({ z: last.child, b: otherChild, alias: last.child, null: null, primitive: true }))
      .toEqual([b, z]);
    expect(getReferenceCounterDefinitions({ a: first.child })).toEqual([a]);

    defineReferenceCounter(otherChild, { id: "z", reference: otherChild.parentId, target: other.id, counter: other.duplicateCount });
    expect(() => getReferenceCounterDefinitions({ z: last.child, otherChild })).toThrow('Duplicate reference counter id or destination: "z".');
  });

  it("requires a single-column foreign key to the actual single-column primary key", () => {
    const parent = pgTable("parent", {
      id: integer("id").notNull(), otherId: integer("other_id").notNull(), count: integer("count").notNull().default(0),
    }, (row) => [primaryKey({ columns: [row.id] })]);
    const child = pgTable("child", {
      parentId: integer("parent_id"), otherId: integer("other_id").references(() => parent.otherId),
    }, (row) => [foreignKey({ columns: [row.parentId, row.otherId], foreignColumns: [parent.id, parent.otherId] })]);
    const options = { id: "parent.count", counter: parent.count };
    expect(() => defineReferenceCounter(child, { ...options, reference: child.parentId, target: parent.id }))
      .toThrow("single-column foreign key to the target");
    expect(() => defineReferenceCounter(child, { ...options, reference: child.otherId, target: parent.otherId }))
      .toThrow("single-column primary key");
  });

  it("rejects a different local column or referenced key even when the foreign key has one column", () => {
    const parent = pgTable("counter_key_owner", {
      id: integer().primaryKey(), other: integer().unique(), count: integer().notNull().default(0),
    });
    const child = pgTable("counter_key_member", {
      expected: integer().references(() => parent.id),
      anotherKey: integer().references(() => parent.other),
      noForeignKey: integer(),
    });

    for (const reference of [child.noForeignKey, child.anotherKey]) {
      expect(() => defineReferenceCounter(child, {
        id: "counter", reference, target: parent.id, counter: parent.count,
      })).toThrow("The reference must declare a single-column foreign key to the target.");
    }
  });

  it("rejects ambiguous primary-key declarations before generating counter SQL", () => {
    const parent = pgTable("counter_duplicate_primary_owner", {
      id: integer().primaryKey(), other: integer().notNull(), count: integer().notNull().default(0),
    }, (row) => [primaryKey({ columns: [row.other] })]);
    const child = pgTable("counter_duplicate_primary_member", {
      reference: integer().references(() => parent.id),
    });

    expect(() => defineReferenceCounter(child, {
      id: "counter", reference: child.reference, target: parent.id, counter: parent.count,
    })).toThrow("The counter target must be a single-column primary key.");
  });

  it("accepts a single-column foreign key declared through Drizzle table configuration", () => {
    const parent = pgTable("parent", { id: integer("id").primaryKey(), count: integer("count").notNull().default(0) });
    const child = pgTable("child", { parentId: integer("parent_id") }, (row) => [
      foreignKey({ columns: [row.parentId], foreignColumns: [parent.id] }),
    ]);

    expect(defineReferenceCounter(child, {
      id: "parent.count", reference: child.parentId, target: parent.id, counter: parent.count,
    }).reference).toBe(child.parentId);
  });

  it("accepts the supported text, UUID and integer key families in the generated SQL", () => {
    const parent = pgTable("mixed_counter_parent", {
      uuidId: uuid().primaryKey(), counter: bigint({ mode: "bigint" }).notNull().default(0n),
    });
    const child = pgTable("mixed_counter_child", {
      reference: uuid().references(() => parent.uuidId),
    });
    expect(defineReferenceCounter(child, {
      id: "uuid.count", target: parent.uuidId, reference: child.reference, counter: parent.counter,
    }).target.getSQLType()).toBe("uuid");

    const keys = { text: () => text(), bigint: () => bigint({ mode: "number" }), smallint: () => smallint() };
    for (const [sqlType, makeKey] of Object.entries(keys)) {
      const owner = pgTable("counter_owner", { id: makeKey().primaryKey(), count: integer().notNull().default(0) });
      const member = pgTable("counter_member", { ownerId: makeKey().references(() => owner.id) });
      expect(defineReferenceCounter(member, {
        id: `${sqlType}.count`, target: owner.id, reference: member.ownerId, counter: owner.count,
      }).reference.getSQLType()).toBe(sqlType);
    }
  });

  it("rejects targeting the same physical key as its counter", () => {
    const parent = pgTable("self_counter_parent", { id: integer().primaryKey().default(0) });
    const child = pgTable("self_counter_child", { parentId: integer().references(() => parent.id) });
    expect(() => defineReferenceCounter(child, {
      id: "same-column", target: parent.id, reference: child.parentId, counter: parent.id,
    })).toThrow("dedicated NOT NULL integer/bigint column");
  });

  it("accepts bounded text keys and rejects counters with incompatible ownership or write behavior", () => {
    const parent = pgTable("parent", {
      id: varchar("id", { length: 16 }).primaryKey(), count: integer("count").notNull().default(0),
      generated: integer("generated").notNull().default(0).generatedAlwaysAs(sql`0`),
      identity: integer("identity").notNull().generatedAlwaysAsIdentity(),
      updated: integer("updated").notNull().default(0).$onUpdateFn(() => 0),
      clientDefault: integer("client_default").notNull().default(0).$defaultFn(() => 0),
      sqlZero: integer("sql_zero").notNull().default(sql` 0 `),
      sqlNonzero: integer("sql_nonzero").notNull().default(sql`1`),
      parentId: varchar("parent_id", { length: 16 }),
    }, (row) => [foreignKey({ columns: [row.parentId], foreignColumns: [row.id] })]);
    const child = pgTable("child", {
      parentId: varchar("parent_id", { length: 16 }).references(() => parent.id),
      count: integer("count").notNull().default(0),
    });
    const options = { id: "parent.count", reference: child.parentId, target: parent.id };
    for (const counter of [child.count, parent.generated, parent.identity, parent.updated, parent.clientDefault]) {
      expect(() => defineReferenceCounter(child, { ...options, counter })).toThrow("dedicated NOT NULL integer/bigint");
    }
    expect(() => defineReferenceCounter(child, { ...options, counter: parent.sqlNonzero })).toThrow("default must be zero");
    expect(() => defineReferenceCounter(parent, { ...options, reference: parent.parentId, counter: parent.count }))
      .toThrow("dedicated NOT NULL integer/bigint");
    expect(defineReferenceCounter(child, { ...options, counter: parent.sqlZero }).target).toBe(parent.id);
  });

  it("rejects duplicate ids and reused destination columns independently", () => {
    const parent = pgTable("parent", {
      id: integer("id").primaryKey(), first: integer("first").notNull().default(0),
      second: integer("second").notNull().default(0), third: integer("third").notNull().default(0),
    });
    const child = pgTable("child", { parentId: integer("parent_id").references(() => parent.id), status: text("status") });
    const options = { reference: child.parentId, target: parent.id };
    expect(() => defineReferenceCounter(child, {
      ...options, id: "a", counter: parent.first, where: () => sql`${[eq(child.status, "closed-over")]}`,
    })).toThrow("supplied source columns");
    defineReferenceCounter(child, { ...options, id: "a", counter: parent.first });
    defineReferenceCounter(child, { ...options, id: "b", counter: parent.second });
    expect(() => defineReferenceCounter(child, { ...options, id: "a", counter: parent.third }))
      .toThrow("Duplicate reference counter id or destination column.");
    expect(() => defineReferenceCounter(child, { ...options, id: "c", counter: parent.second }))
      .toThrow("Duplicate reference counter id or destination column.");
  });
});
