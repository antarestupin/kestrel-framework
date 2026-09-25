import { renderToStaticMarkup } from "react-dom/server";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  DatabaseLayout,
  DatabaseSchemaSection,
} from "./index.js";

describe("DatabaseSchemaSection", () => {
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
      /class="database-column-type">text<\/code><div class="database-column-comment"><button/,
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
            columns: [],
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
  });
});
