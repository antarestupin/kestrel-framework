import { describe, expect, it } from "vitest";
import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { defineDrizzleAtlasFields } from "./index.js";

const records = pgTable("atlas_drizzle_record", {
  recordId: uuid("record_id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  title: text("title").notNull(),
  active: boolean("active").notNull(),
  position: integer("position").notNull(),
  publishedOn: date("published_on", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  metadata: jsonb("metadata"),
});

describe("Drizzle atlas metadata", () => {
  it("derives standard field kinds from public column metadata", () => {
    const fields = defineDrizzleAtlasFields(records);

    expect(fields).toEqual({
      recordId: { kind: "id" },
      ownerId: { kind: "text" },
      title: { kind: "text" },
      active: { kind: "boolean" },
      position: { kind: "number" },
      publishedOn: { kind: "date" },
      createdAt: { kind: "datetime" },
      metadata: { kind: "json" },
    });
  });

  it("applies explicit overrides without leaking an inferred scalar kind into relations", () => {
    const fields = defineDrizzleAtlasFields(records, {
      title: { label: "Public title", hidden: true },
      ownerId: {
        relation: {
          resource: "user",
          cardinality: "one",
        },
      },
    });

    expect(fields.title).toEqual({
      kind: "text",
      label: "Public title",
      hidden: true,
    });
    expect(fields.ownerId).toEqual({
      relation: {
        resource: "user",
        cardinality: "one",
      },
    });
  });
});
