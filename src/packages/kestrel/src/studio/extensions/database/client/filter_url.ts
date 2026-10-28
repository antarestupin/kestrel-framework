/** Update only the filter while preserving custom Studio mounts, other parameters and fragments. */
export function databaseFilterUrl(href: string, hideFramework: boolean): string {
  const url = new URL(href, "http://studio.invalid");
  if (hideFramework) url.searchParams.set("hideFramework", "true");
  else url.searchParams.delete("hideFramework");
  return `${url.pathname}${url.search}${url.hash}`;
}
