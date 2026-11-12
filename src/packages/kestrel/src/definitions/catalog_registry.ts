import { insertCatalogEntry, type CatalogTree } from "../utils/catalog.js";

/** Describes where one catalog definition was contributed from. */
export type CatalogDefinitionSource =
  | { readonly kind: "application" }
  | { readonly kind: "provider"; readonly provider: string };

/** Retains the definition path and provenance used by runtime tooling. */
export interface CatalogDefinitionRegistration<Definition> {
  readonly definition: Definition;
  readonly path: readonly string[];
  readonly source: CatalogDefinitionSource;
}

export interface DefinitionCatalogRegistryOptions<Definition> {
  /** Returns a stable identity when a definition category requires uniqueness. */
  readonly getIdentity?: (definition: Definition) => string;
  readonly identityName?: string;
}

/**
 * Indexes one homogeneous definition category extracted from the app catalog.
 * Paths remain available so consumers can recover the declared hierarchy.
 */
export class DefinitionCatalogRegistry<Definition> {
  private readonly registeredDefinitions: CatalogDefinitionRegistration<Definition>[] = [];
  private readonly registrationsByIdentity = new Map<string, CatalogDefinitionRegistration<Definition>>();
  private readonly registrationsByPath = new Map<string, CatalogDefinitionRegistration<Definition>>();

  public constructor(
    private readonly options: DefinitionCatalogRegistryOptions<Definition> = {},
  ) {}

  /** Registers one definition while rejecting ambiguous paths and identities. */
  public register(
    definition: Definition,
    source: CatalogDefinitionSource = { kind: "application" },
    path: readonly string[],
  ): this {
    if (path.length === 0) {
      throw new TypeError("A catalog registration requires a non-empty path.");
    }
    const pathKey = JSON.stringify(path);
    const existingAtPath = this.registrationsByPath.get(pathKey);

    if (existingAtPath !== undefined) {
      throw new TypeError(
        `Catalog path "${path.join(".")}" is contributed more than once.`,
      );
    }

    const collidingPath = this.registeredDefinitions.find((registration) =>
      isPathPrefix(registration.path, path)
      || isPathPrefix(path, registration.path));

    if (collidingPath !== undefined) {
      throw new TypeError(
        `Catalog path "${path.join(".")}" collides with definition path "${collidingPath.path.join(".")}".`,
      );
    }

    const identity = this.options.getIdentity?.(definition);
    const existingIdentity = identity === undefined
      ? undefined
      : this.registrationsByIdentity.get(identity);

    if (existingIdentity !== undefined) {
      throw new TypeError(
        `${this.options.identityName ?? "Definition"} identities must be unique: "${identity}" is contributed at "${existingIdentity.path.join(".")}" and "${path.join(".")}".`,
      );
    }

    // Keep the indexed path and reported provenance stable across caller mutations.
    const sourceSnapshot = source.kind === "provider"
      ? { kind: source.kind, provider: source.provider }
      : { kind: source.kind };
    const registration = Object.freeze({
      definition,
      path: Object.freeze([...path]),
      source: Object.freeze(sourceSnapshot),
    });

    this.registeredDefinitions.push(registration);
    this.registrationsByPath.set(pathKey, registration);

    if (identity !== undefined) {
      this.registrationsByIdentity.set(identity, registration);
    }

    return this;
  }

  /** Lists definitions in deterministic contribution and declaration order. */
  public get definitions(): readonly Definition[] {
    return this.registeredDefinitions.map(({ definition }) => definition);
  }

  /** Returns a snapshot of definitions together with their declaration metadata. */
  public get registrations(): readonly CatalogDefinitionRegistration<Definition>[] {
    return Object.freeze([...this.registeredDefinitions]);
  }

  /** Reconstructs the homogeneous nested view consumed by catalog-aware tools. */
  public get catalog(): CatalogTree<Definition> {
    const catalog: Record<string, Definition | CatalogTree<Definition>> = {};

    for (const registration of this.registeredDefinitions) {
      insertCatalogEntry(catalog, registration.path, registration.definition);
    }

    return catalog;
  }
}

/** Matches every leading segment. Identical paths were already rejected by the index. */
function isPathPrefix(
  prefix: readonly string[],
  path: readonly string[],
): boolean {
  return prefix.every((part, index) => path[index] === part);
}
