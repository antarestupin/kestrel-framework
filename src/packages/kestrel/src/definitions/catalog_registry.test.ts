import { describe, expect, it } from "vitest";

import { DefinitionCatalogRegistry } from "./catalog_registry.js";
import { DefinitionRegistry } from "./registry.js";

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

  it("compares entire branch paths and reports the original path on conflicts", () => {
    const registry = new DefinitionCatalogRegistry<string>()
      .register("read", application, ["domain", "read"])
      .register("write", provider, ["domain", "write", "entry"]);
    expect(registry.catalog).toEqual({ domain: { read: "read", write: { entry: "write" } } });
    expect(() => registry.register("duplicate", provider, ["domain", "read"]))
      .toThrow('Catalog path "domain.read" is contributed more than once.');
    expect(() => registry.register("parent", provider, ["domain", "write"]))
      .toThrow('Catalog path "domain.write" collides with definition path "domain.write.entry".');
  });

  it("rejects a root definition before it can block later named entries", () => {
    const registry = new DefinitionCatalogRegistry<string>();
    expect(() => registry.register("unaddressable", application, []))
      .toThrow("A catalog registration requires a non-empty path.");
    registry.register("available", application, ["named"]);
    expect(registry.catalog).toEqual({ named: "available" });
  });

  it("retains direct application provenance when JavaScript omits it", () => {
    const registry = new DefinitionCatalogRegistry<string>()
      .register("read", undefined, ["read"]);
    expect(registry.registrations[0]?.source).toStrictEqual({ kind: "application" });
  });

  it("isolates registration provenance and path from callers and readers", () => {
    const source = { kind: "provider" as const, provider: "OriginalProvider" };
    const definition = { id: "read" };
    const registry = new DefinitionCatalogRegistry<typeof definition>()
      .register(definition, source, ["domain", "read"]);
    const registrations = registry.registrations;
    source.provider = "ChangedProvider";
    expect(Reflect.set(registrations[0]!.path, 0, "changed")).toBe(false);
    expect(Reflect.set(registrations[0]!.source, "provider", "ChangedAgain")).toBe(false);
    expect(Reflect.set(registrations[0]!, "definition", { id: "another" })).toBe(false);
    expect(Reflect.deleteProperty(registrations, "0")).toBe(false);
    expect(registry.registrations[0]?.source).toEqual({ kind: "provider", provider: "OriginalProvider" });
    expect(registry.catalog.domain).toEqual({ read: definition });
    expect(registry.definitions[0]).toBe(definition);
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

describe("DefinitionRegistry", () => {
  it("publishes an immutable snapshot while retaining the definitions' identity", () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const registry = new DefinitionRegistry<typeof first>().register(first);
    const snapshot = registry.definitions;
    registry.register(second);
    expect(snapshot).toEqual([first]);
    expect(Reflect.set(snapshot, 0, second)).toBe(false);
    expect(registry.definitions[0]).toBe(first);
    expect(registry.definitions[1]).toBe(second);
  });
});
