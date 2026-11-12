import { describe, expect, it } from "vitest";

import { DefinitionCatalogRegistry } from "./catalog_registry.js";

const application = { kind: "application" } as const;
const provider = { kind: "provider", provider: "TestProvider" } as const;

describe("DefinitionCatalogRegistry", () => {
  it.each([
    { first: ["domain", "read"], second: ["domain", "read"], message: "contributed more than once" },
    { first: ["domain", "read"], second: ["domain"], message: "collides with definition path" },
    { first: ["domain"], second: ["domain", "read"], message: "collides with definition path" },
  ])("rejects conflicting paths $first and $second without replacing the registration", ({ first, second, message }) => {
    const registry = new DefinitionCatalogRegistry<string>().register("read", application, first);

    expect(() => registry.register("write", provider, second)).toThrow(message);
    expect(registry.registrations).toEqual([{ definition: "read", path: first, source: application }]);
  });

  it("uses a generic name in duplicate identity diagnostics when no category name is provided", () => {
    const registry = new DefinitionCatalogRegistry({ getIdentity: (definition: { id: string }) => definition.id });
    registry.register({ id: "read" }, application, ["domain", "read"]);

    expect(() => registry.register({ id: "read" }, provider, ["extension", "read"]))
      .toThrow('Definition identities must be unique: "read" is contributed at "domain.read" and "extension.read".');
  });

  it("copies registration paths and reconstructs shared branches in declaration order", () => {
    const path = ["domain", "read"];
    const registry = new DefinitionCatalogRegistry<string>()
      .register("read", application, path)
      .register("write", provider, ["domain", "write"]);
    path.push("mutated");

    expect(registry.definitions).toEqual(["read", "write"]);
    expect(registry.catalog).toEqual({ domain: { read: "read", write: "write" } });
  });

  it("keeps prototype-named paths in the catalog's own properties", () => {
    const key = "__kestrelDefinitionCatalogProjection";
    const registry = new DefinitionCatalogRegistry<string>()
      .register("read", application, ["__proto__", key])
      .register("write", provider, ["constructor"]);

    // Clean up the prototype even when running this regression against the old code.
    try {
      const catalog = registry.catalog;
      expect(Object.hasOwn(catalog, "__proto__")).toBe(true);
      expect(Object.hasOwn(Object.prototype, key)).toBe(false);
      expect(catalog).toEqual({ ["__proto__"]: { [key]: "read" }, constructor: "write" });
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  });
});
