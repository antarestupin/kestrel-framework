import {
  DefinitionCatalogRegistry,
  type CatalogDefinitionSource,
} from "../definitions/index.js";
import {
  isAction,
  isCliController,
  isHttpController,
  isObject,
  isScheduledTask,
  isWorker,
  isWorkflow,
  type AnyAction,
  type AnyCliController,
  type AnyHttpController,
  type AnyScheduledTask,
  type AnyWorker,
  type AnyWorkflow,
} from "../utils/index.js";
import { ScheduledTaskRegistry } from "../scheduled_tasks/registry.js";

/** A recursively composed declaration whose exact shape is preserved. */
export type AppCatalogDeclaration = {
  readonly [key: string]: AppCatalogDeclaration | AppCatalogDefinition;
};

type AppCatalogDefinition =
  | AnyAction
  | AnyCliController
  | AnyHttpController
  | AnyScheduledTask
  | AnyWorker
  | AnyWorkflow;

type ReservedCatalogKey =
  | "actions"
  | "controllers"
  | "workers"
  | "workflows"
  | "scheduledTasks";

type Simplify<Value> = { [Key in keyof Value]: Value[Key] };

type SubcatalogKeys<Catalog> = {
  [Key in keyof Catalog]: Key extends ReservedCatalogKey ? never : Key;
}[keyof Catalog];

type NonEmptyBranchKeys<Catalog, Category extends CatalogCategory> = {
  [Key in SubcatalogKeys<Catalog>]: keyof SelectCatalogCategory<
    Catalog[Key],
    Category
  > extends never ? never : Key;
}[SubcatalogKeys<Catalog>];

type CatalogCategory =
  | "actions"
  | "httpControllers"
  | "cliControllers"
  | "workers"
  | "workflows"
  | "scheduledTasks";

type LocalCatalogCategory<Catalog, Category extends CatalogCategory> =
  Category extends "actions"
    ? Catalog extends { readonly actions: infer Definitions } ? Definitions : {}
    : Category extends "workers"
      ? Catalog extends { readonly workers: infer Definitions } ? Definitions : {}
      : Category extends "workflows"
        ? Catalog extends { readonly workflows: infer Definitions } ? Definitions : {}
        : Category extends "scheduledTasks"
          ? Catalog extends { readonly scheduledTasks: infer Definitions } ? Definitions : {}
          : Category extends "httpControllers"
            ? Catalog extends {
                readonly controllers: { readonly http: infer Definitions };
              } ? Definitions : {}
            : Catalog extends {
                readonly controllers: { readonly cli: infer Definitions };
              } ? Definitions : {};

/** Exact homogeneous projection derived from one heterogeneous declaration. */
export type SelectCatalogCategory<
  Catalog,
  Category extends CatalogCategory,
> = Catalog extends object
  ? Simplify<
      LocalCatalogCategory<Catalog, Category>
      & {
        [Key in NonEmptyBranchKeys<Catalog, Category>]:
          SelectCatalogCategory<Catalog[Key], Category>;
      }
    >
  : {};

/** Identity helper used to preserve the exact declaration type. */
export function defineCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): Catalog {
  return catalog;
}

/** Derives the typed action-only view without creating a second declaration. */
export function selectActionCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "actions"> {
  return selectCatalogCategory(catalog, "actions");
}

/** Derives the typed HTTP-controller view used by transport-specific tooling. */
export function selectHttpControllerCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "httpControllers"> {
  return selectCatalogCategory(catalog, "httpControllers");
}

/** Derives the typed CLI-controller view used by command tooling. */
export function selectCliControllerCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "cliControllers"> {
  return selectCatalogCategory(catalog, "cliControllers");
}

/** Derives the typed worker-only view used by queue tooling. */
export function selectWorkerCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "workers"> {
  return selectCatalogCategory(catalog, "workers");
}

/** Derives the typed durable-workflow view used by runtime tooling. */
export function selectWorkflowCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "workflows"> {
  return selectCatalogCategory(catalog, "workflows");
}

/** Derives the typed scheduled-task view used by scheduler tooling. */
export function selectScheduledTaskCatalog<const Catalog extends AppCatalogDeclaration>(
  catalog: Catalog,
): SelectCatalogCategory<Catalog, "scheduledTasks"> {
  return selectCatalogCategory(catalog, "scheduledTasks");
}

/**
 * Owns the consolidated runtime indexes derived from application and provider
 * catalog contributions.
 */
export class AppCatalog<Declaration extends AppCatalogDeclaration = AppCatalogDeclaration> {
  public readonly actions = new DefinitionCatalogRegistry<AnyAction>({
    getIdentity: ({ name }) => name,
    identityName: "Action",
  });

  public readonly httpControllers = new DefinitionCatalogRegistry<AnyHttpController>();

  public readonly cliControllers = new DefinitionCatalogRegistry<AnyCliController>({
    getIdentity: ({ command }) => command,
    identityName: "CLI controller",
  });

  public readonly workers = new DefinitionCatalogRegistry<AnyWorker>({
    getIdentity: ({ queue }) => queue,
    identityName: "Worker queue",
  });

  public readonly workflows = new DefinitionCatalogRegistry<AnyWorkflow>({
    getIdentity: ({ name }) => name,
    identityName: "Workflow",
  });

  public readonly scheduledTasks = new ScheduledTaskRegistry();

  public constructor(
    public readonly declaration: Declaration,
    private readonly canContribute: () => boolean,
  ) {
    this.contribute(declaration, { kind: "application" });
  }

  /** Adds one catalog during composition and retains its source and hierarchy. */
  public contribute(
    catalog: AppCatalogDeclaration,
    source: CatalogDefinitionSource,
  ): this {
    if (!this.canContribute()) {
      throw new Error("Catalogs can only be contributed during composition.");
    }

    this.visitCatalog(catalog, source, []);
    return this;
  }

  private visitCatalog(
    catalog: AppCatalogDeclaration,
    source: CatalogDefinitionSource,
    parentPath: readonly string[],
  ): void {
    for (const [name, value] of Object.entries(catalog)) {
      if (name === "actions") {
        this.registerSection(value, source, parentPath, isAction, this.actions);
      } else if (name === "workers") {
        this.registerSection(value, source, parentPath, isWorker, this.workers);
      } else if (name === "workflows") {
        this.registerSection(value, source, parentPath, isWorkflow, this.workflows);
      } else if (name === "scheduledTasks") {
        this.registerSection(value, source, parentPath, isScheduledTask, this.scheduledTasks);
      } else if (name === "controllers") {
        this.registerControllers(value, source, parentPath);
      } else {
        if (isDefinition(value)) {
          throw new TypeError(
            `Catalog definition at "${[...parentPath, name].join(".")}" must be declared below a definition category.`,
          );
        }

        this.visitCatalog(value, source, [...parentPath, name]);
      }
    }
  }

  private registerControllers(
    value: AppCatalogDeclaration | AppCatalogDefinition,
    source: CatalogDefinitionSource,
    parentPath: readonly string[],
  ): void {
    if (!isObject(value) || isDefinition(value)) {
      throw new TypeError(`Catalog controllers at "${parentPath.join(".")}" must be a catalog branch.`);
    }

    for (const [transport, controllers] of Object.entries(value)) {
      if (transport === "http") {
        this.registerSection(controllers, source, parentPath, isHttpController, this.httpControllers);
      } else if (transport === "cli") {
        this.registerSection(controllers, source, parentPath, isCliController, this.cliControllers);
      } else {
        throw new TypeError(`Unsupported controller catalog transport "${transport}" at "${parentPath.join(".")}".`);
      }
    }
  }

  private registerSection<Definition>(
    value: AppCatalogDeclaration | AppCatalogDefinition,
    source: CatalogDefinitionSource,
    parentPath: readonly string[],
    isDefinitionOfKind: (value: unknown) => value is Definition,
    registry: {
      register(
        definition: Definition,
        source: CatalogDefinitionSource,
        path: readonly string[],
      ): unknown;
    },
  ): void {
    if (!isObject(value) || isDefinition(value)) {
      throw new TypeError(`Catalog category at "${parentPath.join(".")}" must contain named definitions.`);
    }

    visitDefinitionTree(value, parentPath, isDefinitionOfKind, (definition, path) => {
      registry.register(definition, source, path);
    });
  }
}

/** Traverses a homogeneous category while retaining its nested declaration path. */
function visitDefinitionTree<Definition>(
  tree: Record<string, unknown>,
  parentPath: readonly string[],
  isDefinitionOfKind: (value: unknown) => value is Definition,
  visit: (definition: Definition, path: readonly string[]) => void,
): void {
  for (const [name, value] of Object.entries(tree)) {
    const path = [...parentPath, name];

    if (isDefinitionOfKind(value)) {
      visit(value, path);
    } else if (isObject(value) && !isDefinition(value)) {
      visitDefinitionTree(value, path, isDefinitionOfKind, visit);
    } else {
      throw new TypeError(`Invalid definition at catalog path "${path.join(".")}".`);
    }
  }
}

function isDefinition(value: unknown): value is AppCatalogDefinition {
  return isAction(value)
    || isHttpController(value)
    || isCliController(value)
    || isWorker(value)
    || isWorkflow(value)
    || isScheduledTask(value);
}

/** Builds one homogeneous projection through the same validated runtime index. */
function selectCatalogCategory<
  const Catalog extends AppCatalogDeclaration,
  const Category extends CatalogCategory,
>(
  catalog: Catalog,
  category: Category,
): SelectCatalogCategory<Catalog, Category> {
  const appCatalog = new AppCatalog(catalog, () => true);
  const selected = category === "actions"
    ? appCatalog.actions.catalog
    : category === "httpControllers"
      ? appCatalog.httpControllers.catalog
      : category === "cliControllers"
        ? appCatalog.cliControllers.catalog
        : category === "workers"
          ? appCatalog.workers.catalog
          : category === "workflows"
            ? appCatalog.workflows.catalog
            : appCatalog.scheduledTasks.catalog;

  return selected as SelectCatalogCategory<Catalog, Category>;
}
