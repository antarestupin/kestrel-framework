import { and, eq, isNull, sql } from "drizzle-orm";
import { integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core";
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

  it("quotes physical identifiers including schemas and table names containing dots", () => {
    const schema = pgSchema('odd.schema"');
    const parent = schema.table('parent.name"', { id: integer('key"').primaryKey(), count: integer('count"').notNull().default(0) });
    const child = schema.table('child.name"', { parent: integer('ref"').references(() => parent.id) });
    defineReferenceCounter(child, { id: "a".repeat(100), reference: child.parent, target: parent.id, counter: parent.count });
    const [contribution] = getDatabaseSchemaContributions({ child });
    expect(contribution!.installSql).toContain('"odd.schema"""."parent.name"""');
    expect(contribution!.uninstallBeforeSql).toContain('DROP FUNCTION IF EXISTS "odd.schema"""."__counter_');
  });
});
