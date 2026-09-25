import { format } from "sql-formatter";

export interface SqlFormatOptions {
  /** Preferred width used by formatters that can adapt their layout. */
  lineWidth: number;
}

/** Keeps observation rendering independent from the selected SQL engine. */
export interface SqlFormatter {
  format(sql: string, options: SqlFormatOptions): string;
}

/** Adapts the lightweight JavaScript formatter to Studio's narrow contract. */
export const postgresqlSqlFormatter: SqlFormatter = {
  format: (sql, options) => format(sql, {
    language: "postgresql",
    tabWidth: 2,
    keywordCase: "upper",
    expressionWidth: options.lineWidth,
    linesBetweenQueries: 1,
  }),
};

/** Formats diagnostic SQL without allowing display failures to hide the query. */
export function formatSqlForDisplay(
  sql: string,
  options: SqlFormatOptions,
  formatter: SqlFormatter = postgresqlSqlFormatter,
): string {
  try {
    return formatter.format(sql, options);
  } catch {
    return sql;
  }
}
