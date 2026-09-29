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
