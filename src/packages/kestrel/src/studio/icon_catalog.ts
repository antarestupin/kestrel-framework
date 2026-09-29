import type { SvgIconDefinition } from "./icon_definition.js";

export type IconCatalogManifest = Readonly<Record<string, SvgIconDefinition>>;

/** Deduplicates serialized icons while compiling the Studio manifest. */
export class IconCatalogBuilder {
  private readonly idsByDefinition = new Map<string, string>();
  private readonly definitions: Record<string, SvgIconDefinition> = {};

  public add(definition: SvgIconDefinition): string {
    // Use a canonical key so object property insertion order cannot defeat
    // deduplication for otherwise equivalent icon definitions.
    const serialized = JSON.stringify([
      definition.type,
      definition.viewBox,
      definition.paths.map((path) => [path.d, path.opacity ?? null]),
    ]);
    const existingId = this.idsByDefinition.get(serialized);

    if (existingId !== undefined) {
      return existingId;
    }

    const id = `icon-${this.idsByDefinition.size + 1}`;

    this.idsByDefinition.set(serialized, id);
    this.definitions[id] = definition;
    return id;
  }

  public toManifest(): IconCatalogManifest {
    return { ...this.definitions };
  }
}
