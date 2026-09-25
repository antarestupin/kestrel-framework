import type { CatalogTree } from "../utils/catalog.js";

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
    source: CatalogDefinitionSource,
    path: readonly string[],
  ): this {
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

    const registration = {
      definition,
      path: [...path],
      source,
    };

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

  /** Lists definitions together with their declaration metadata. */
  public get registrations(): readonly CatalogDefinitionRegistration<Definition>[] {
    return this.registeredDefinitions;
  }

  /** Reconstructs the homogeneous nested view consumed by catalog-aware tools. */
  public get catalog(): CatalogTree<Definition> {
    const catalog: Record<string, Definition | CatalogTree<Definition>> = {};

    for (const registration of this.registeredDefinitions) {
      insertAtPath(catalog, registration.path, registration.definition);
    }

    return catalog;
  }
}

/** Returns whether a path is a strict prefix of another catalog path. */
function isPathPrefix(
  prefix: readonly string[],
  path: readonly string[],
): boolean {
  return prefix.length < path.length
    && prefix.every((part, index) => path[index] === part);
}

/** Inserts a definition into a fresh catalog tree and validates branch collisions. */
function insertAtPath<Definition>(
  catalog: Record<string, Definition | CatalogTree<Definition>>,
  path: readonly string[],
  definition: Definition,
): void {
  let branch = catalog;

  for (const [index, part] of path.entries()) {
    const isLeaf = index === path.length - 1;
    const existing = branch[part];

    if (isLeaf) {
      if (existing !== undefined) {
        throw new TypeError(`Catalog path "${path.join(".")}" collides with an existing branch.`);
      }

      branch[part] = definition;
      return;
    }

    if (existing === undefined) {
      const child: Record<string, Definition | CatalogTree<Definition>> = {};
      branch[part] = child;
      branch = child;
      continue;
    }

    if (typeof existing !== "object" || existing === null) {
      throw new TypeError(`Catalog path "${path.join(".")}" collides with an existing definition.`);
    }

    branch = existing as Record<string, Definition | CatalogTree<Definition>>;
  }
}
