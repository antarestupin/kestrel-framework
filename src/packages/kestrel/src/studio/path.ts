/** Joins a Studio-relative route to its mount point in the server or browser. */
export function joinStudioPath(
  basePath: string,
  relativePath: `/${string}`,
): string {
  return basePath === "/" ? relativePath : `${basePath}${relativePath}`;
}
