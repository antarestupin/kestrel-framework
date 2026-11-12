import {
  describe,
  expect,
  it,
} from "vitest";

import {
  flattenCatalog,
  insertCatalogEntry,
  type CatalogTree,
} from "./catalog.js";

interface CatalogItem {
  readonly kind: "item";
  readonly name: string;
}

function isCatalogItem(value: unknown): value is CatalogItem {
  return (
    typeof value === "object"
    && value !== null
    && "kind" in value
    && value.kind === "item"
  );
}

describe("flattenCatalog", () => {
  it("flattens branches of arbitrary depth in declaration order", () => {
    const first = { kind: "item", name: "first" } as const;
    const second = { kind: "item", name: "second" } as const;
    const third = { kind: "item", name: "third" } as const;
    const catalog: CatalogTree<CatalogItem> = {
      shallow: first,
      nested: {
        second,
        deeper: {
          third,
        },
      },
    };

    expect(flattenCatalog<CatalogItem>(catalog, isCatalogItem)).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("keeps object items terminal instead of traversing their fields", () => {
    const item = { kind: "item", name: "terminal" } as const;

    expect(flattenCatalog<CatalogItem>({ item }, isCatalogItem)).toEqual([
      item,
    ]);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(flattenCatalog<CatalogItem>({}, isCatalogItem)).toEqual([]);
  });
});

describe("insertCatalogEntry", () => {
  const item = { kind: "item", name: "registered" } as const;

  it("creates own data properties for names inherited from the prototype", () => {
    const inherited = { branch: { original: item } };
    const catalog: Record<string, CatalogItem | CatalogTree<CatalogItem>> = Object.create(inherited);

    insertCatalogEntry(catalog, ["branch", "first"], item);
    insertCatalogEntry(catalog, ["branch", "__proto__"], item);

    expect(Object.getPrototypeOf(catalog)).toBe(inherited);
    expect(inherited.branch).toEqual({ original: item });
    expect(Object.getOwnPropertyDescriptor(catalog.branch!, "__proto__")).toEqual({
      value: item, enumerable: true, configurable: true, writable: true,
    });
    expect(Object.keys(catalog)).toEqual(["branch"]);
    expect(flattenCatalog(catalog, isCatalogItem)).toEqual([item, item]);
  });

  it("reports the complete path on collisions and preserves the existing value", () => {
    const catalog = { group: { item }, blocked: null, text: "existing" };
    const writable: Record<string, unknown> = catalog;

    for (const path of [["group", "item"], ["blocked", "item"], ["text", "item"]]) {
      expect(() => insertCatalogEntry(writable, path, item)).toThrow(
        `Catalog path "${path.join(".")}" collides with an existing entry.`,
      );
    }
    expect(catalog).toEqual({ group: { item }, blocked: null, text: "existing" });
  });
});
