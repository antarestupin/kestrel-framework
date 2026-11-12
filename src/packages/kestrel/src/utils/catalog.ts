/** A recursively nested catalog whose terminal values share one type. */
export type CatalogTree<Item> = {
  readonly [key: string]: Item | CatalogTree<Item>;
};

/**
 * Extracts every terminal catalog item while preserving declaration order.
 *
 * Catalog items can themselves be objects, so callers provide the predicate
 * that distinguishes a terminal item from another catalog branch.
 */
export function flattenCatalog<Item>(
  catalog: CatalogTree<Item>,
  isItem: (value: unknown) => value is Item,
): readonly Item[] {
  return Object.values(catalog).flatMap((value) =>
    isItem(value)
      ? [value]
      : flattenCatalog(value, isItem));
}

/** Inserts an entry without reading or changing inherited properties. */
export function insertCatalogEntry<Item>(
  catalog: Record<string, Item | CatalogTree<Item>>,
  path: readonly string[],
  item: Item,
): void {
  let branch = catalog;

  for (const [index, part] of path.entries()) {
    const isLeaf = index === path.length - 1;
    const existing = Object.getOwnPropertyDescriptor(branch, part);

    if (existing === undefined) {
      const value = isLeaf ? item : {};
      // Use a data property even for names with setters on Object.prototype.
      Object.defineProperty(branch, part, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (isLeaf) return;
      branch = value as Record<string, Item | CatalogTree<Item>>;
      continue;
    }

    if (isLeaf || typeof existing.value !== "object" || existing.value === null) {
      throw new TypeError(`Catalog path "${path.join(".")}" collides with an existing entry.`);
    }

    branch = existing.value as Record<string, Item | CatalogTree<Item>>;
  }
}
