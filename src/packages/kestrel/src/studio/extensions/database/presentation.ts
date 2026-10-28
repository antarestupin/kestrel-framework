/** Shared browser-safe aliases keep the HTML and SVG type labels consistent. */
export function formatDatabaseColumnType(type: string): string {
  return type
    .replace(/^timestamp(\(\d+\))? with time zone((?:\[\])*)$/, "timestamptz$1$2")
    .replace(/^timestamp(\(\d+\))? without time zone((?:\[\])*)$/, "timestamp$1$2")
    .replace(/^time(\(\d+\))? with time zone((?:\[\])*)$/, "timetz$1$2")
    .replace(/^time(\(\d+\))? without time zone((?:\[\])*)$/, "time$1$2")
    .replace(/^character varying(\(\d+\))?((?:\[\])*)$/, "varchar$1$2")
    .replace(/^double precision((?:\[\])*)$/, "float8$1");
}
