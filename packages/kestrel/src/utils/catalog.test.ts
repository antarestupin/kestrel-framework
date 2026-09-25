import {
  describe,
  expect,
  it,
} from "vitest";

import {
  flattenCatalog,
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
