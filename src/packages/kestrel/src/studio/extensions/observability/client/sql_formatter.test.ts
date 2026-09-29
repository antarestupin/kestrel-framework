import { describe, expect, it } from "vitest";

import {
  formatSqlForDisplay,
  type SqlFormatter,
} from "./sql_formatter.js";

describe("formatSqlForDisplay", () => {
  it("formats PostgreSQL while preserving positional parameters", () => {
    expect(formatSqlForDisplay(
      "select id, email from users where id = $1",
      { lineWidth: 100 },
    )).toBe([
      "SELECT",
      "  id,",
      "  email",
      "FROM",
      "  users",
      "WHERE",
      "  id = $1",
    ].join("\n"));
  });

  it("returns the original SQL when the selected formatter fails", () => {
    const formatter: SqlFormatter = {
      format: () => {
        throw new Error("Unsupported syntax");
      },
    };

    expect(formatSqlForDisplay(
      "select custom syntax",
      { lineWidth: 100 },
      formatter,
    )).toBe("select custom syntax");
  });
});
