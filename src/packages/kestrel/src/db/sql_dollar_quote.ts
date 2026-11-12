/** Retain the ordinary delimiter unless the SQL body contains it as data. */
export function quoteSqlBody(body: string, label: string): string {
  let delimiter = `$${label}$`;
  for (let suffix = 1; body.includes(delimiter); suffix += 1) {
    delimiter = `$${label}_${suffix}$`;
  }
  return `${delimiter}\n${body}\n${delimiter}`;
}
