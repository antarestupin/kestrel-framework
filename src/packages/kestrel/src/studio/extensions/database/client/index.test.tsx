import { renderToStaticMarkup } from "react-dom/server";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  DatabaseLayout,
  DatabaseDiagramLink,
  DatabaseSchemaSection,
} from "./index.js";

describe("DatabaseSchemaSection", () => {
  it("links to the SVG resource under the configured Studio mount", () => {
    const markup = renderToStaticMarkup(
      <DatabaseDiagramLink dataPath="/tools/studio/api/extensions/database/schema" />,
    );

    expect(markup).toContain('href="/tools/studio/api/extensions/database/schema.svg"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Open SVG diagram");
  });

  it("offers the HTML filter and propagates its enabled state to the SVG resource", () => {
    const link = renderToStaticMarkup(<DatabaseDiagramLink dataPath="/tools/api/extensions/database/schema" hideFramework />);
    expect(link).toContain('href="/tools/api/extensions/database/schema.svg?hideFramework=true"');
    const page = renderToStaticMarkup(<DatabaseLayout layout={{ schemas: [] }} />);
    expect(page).toContain("Hide framework tables");
    expect(page).toContain('aria-pressed="false"');
  });

  it("restores the URL-selected filter in the table overview and SVG export", () => {
    const markup = renderToStaticMarkup(<DatabaseLayout dataPath="/tools/api/extensions/database/schema" hideFramework layout={{ schemas: [
      { name: "dev", tables: [{ name: "log", kind: "table", origin: "framework", columns: [] }] },
      { name: "public", tables: [{ name: "note", kind: "table", columns: [] }] },
    ] }} />);
    expect(markup).toContain("Show framework tables");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('title="dev.log"');
    expect(markup).toContain('title="public.note"');
    expect(markup).toContain('href="/tools/api/extensions/database/schema.svg?hideFramework=true"');
    expect(markup).toContain("1 table across 1 schema");
    expect(markup).not.toContain("No tables remain after filtering.");
  });

  it("signals comments while keeping every description collapsed initially", () => {
    const markup = renderToStaticMarkup(
      <DatabaseSchemaSection schema={{
        name: "members",
        description: "Member data.",
        tables: [{
          name: "member",
          description: "Member identities.",
          kind: "table",
          columns: [
            {
              name: "email",
              description: "The member email.",
              type: "text",
              nullable: false,
              primaryKey: false,
            },
            {
              name: "created_at",
              type: "timestamp with time zone",
              nullable: false,
              primaryKey: false,
            },
          ],
        }],
      }} />,
    );

    expect(markup.match(/class="database-comment-button"/g)).toHaveLength(3);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(markup.match(/database-comment-chevron/g)).toHaveLength(3);
    expect(markup.match(/hidden=""/g)).toHaveLength(3);
    expect(markup).toContain("Show comment for schema members");
    expect(markup).toContain("Show comment for table members.member");
    expect(markup).toContain("Show comment for column members.member.email");
    expect(markup.match(/class="database-column-comment"/g)).toHaveLength(2);
    expect(markup).toMatch(
      /class="database-table-controls"><button[^>]+database-comment-button/,
    );
    expect(markup).toMatch(
      /class="database-column-type" title="text">text<\/code><div class="database-column-comment"><button/,
    );
  });

  it("offers a page-wide control when the layout contains comments", () => {
    const markup = renderToStaticMarkup(
      <DatabaseLayout layout={{
        schemas: [{
          name: "members",
          description: "Member data.",
          tables: [{
            name: "member",
            kind: "table",
            columns: [],
          }],
        }],
      }} />,
    );

    expect(markup).toContain("Expand all comments");
    expect(markup).toContain('aria-pressed="false"');
  });

  it("omits the page-wide control when the layout has no comments", () => {
    const markup = renderToStaticMarkup(
      <DatabaseLayout layout={{
        schemas: [{
          name: "public",
          tables: [{
            name: "marker",
            kind: "table",
            columns: [{ name: "id", type: "uuid", nullable: false, primaryKey: true }],
          }],
        }],
      }} />,
    );

    expect(markup).not.toContain("database-comments-toggle");
  });

  it("does not render comment controls for undocumented objects", () => {
    const markup = renderToStaticMarkup(
      <DatabaseSchemaSection schema={{
        name: "public",
        tables: [{
          name: "marker",
          kind: "table",
          columns: [{
            name: "id",
            type: "uuid",
            nullable: false,
            primaryKey: true,
          }],
        }],
      }} />,
    );

    expect(markup).not.toContain("database-comment-button");
    expect(markup).not.toContain("database-schema-description");
    expect(markup).not.toContain("database-table-description");
    expect(markup).not.toContain("database-column-description");
    expect(markup).toContain(
      '<div class="database-column-comment"></div>',
    );
    expect(markup).toContain('class="database-schema" data-columns="1" style="left:0;top:0;width:324px;height:111px"');
    expect(markup).toMatch(/class="database-table-card"[^>]*style="left:12px;top:44px;width:300px"/);
  });

  it("groups tables into labeled frames and retains compact type and key details", () => {
    const markup = renderToStaticMarkup(<DatabaseLayout layout={{ schemas: [
      { name: "identity", tables: [{
        name: "member", kind: "table",
        columns: [
          { name: "created_at", type: "timestamp(3) with time zone", primaryKey: true, nullable: true },
          { name: "event_id", type: "uuid", primaryKey: false, nullable: false },
          { name: "nickname", type: "text", primaryKey: false, nullable: true },
        ],
        foreignKeys: [
          { name: "member_created_fk", columns: ["created_at"], referencedSchema: "audit", referencedTable: "event", referencedColumns: ["created_at"] },
          { name: "member_event_fk", columns: ["event_id", "created_at"], referencedSchema: "audit", referencedTable: "event", referencedColumns: ["id", "created_at"] },
        ],
      }] },
      { name: "audit", tables: [{ name: "event", kind: "table", columns: [] }] },
    ] }} />);

    expect(markup).toContain('class="database-schema-groups"');
    expect(markup).toContain('class="database-layout-summary">2 tables across 2 schemas');
    const groups = markup.split("<section ").slice(1);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain('title="identity.member"');
    expect(groups[0]).not.toContain('title="audit.event"');
    expect(groups[1]).toContain('title="audit.event"');
    expect(groups[0]).toContain('class="database-schema-count">1 table');
    expect(groups[0]).not.toContain("No columns");
    expect(groups[1]).toContain("No columns");
    expect(markup).not.toContain("No tables</p>");
    expect(markup).not.toContain("No tables remain after filtering.");
    expect(markup.match(/aria-labelledby=/g)).toHaveLength(2);
    expect(markup).toContain('title="timestamp(3) with time zone">timestamptz(3)</code>');
    expect(markup).toContain('title="identity.member.created_at"');
    expect(markup).toContain('title="Primary key">PK</abbr>');
    expect(markup).toContain(
      'title="member_created_fk: (created_at) → audit.event(created_at)\nmember_event_fk: (event_id, created_at) → audit.event(id, created_at)">FK</abbr>',
    );
    expect(markup.match(/>FK<\/abbr>/g)).toHaveLength(2);
    expect(markup).toContain('title="Nullable">?</span>');
  });

  it("uses shared balanced geometry beyond the page width and handles empty groups", () => {
    const markup = renderToStaticMarkup(<DatabaseLayout layout={{ schemas: [
      { name: "public", tables: Array.from({ length: 48 }, (_, index) => ({ name: `record_${index}`, kind: "table", columns: Array.from({ length: 12 }, (_, column) => ({ name: `column_${column}`, type: "text", primaryKey: false, nullable: false })) })) },
      { name: "pair", tables: Array.from({ length: 2 }, (_, index) => ({ name: `pair_${index}`, kind: "table", columns: [] })) },
      { name: "triple", tables: Array.from({ length: 3 }, (_, index) => ({ name: `triple_${index}`, kind: "table", columns: [] })) },
      { name: "empty", tables: [] },
    ] }} />);

    expect(markup).toContain('data-columns="7"');
    const canvasWidth = Number(/class="database-schema-groups" style="width:(\d+)px/.exec(markup)?.[1]);
    expect(canvasWidth).toBeGreaterThan(1480);
    expect(markup).toContain('data-columns="1"');
    expect(markup.match(/class="database-table-card"/g)).toHaveLength(53);
    expect([...markup.matchAll(/class="database-schema-count">([^<]+)/g)].map((match) => match[1]))
      .toEqual(["48 tables", "2 tables", "3 tables", "0 tables"]);
    expect(markup).toContain("No tables");
  });
});
