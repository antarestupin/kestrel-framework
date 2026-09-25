import {
  isHttpController,
  type AnyHttpController,
  type CatalogTree,
} from "../../utils/index.js";
import {
  type HttpControllerAudienceDefinition,
  resolveHttpControllerAudiences,
  validateHttpControllerAudienceFilter,
} from "./audience.js";

/**
 * Selects controllers by audience while preserving the remaining catalog
 * hierarchy and removing branches that became empty.
 */
export function filterHttpControllerCatalog(
  catalog: CatalogTree<AnyHttpController>,
  controllerAudiences: HttpControllerAudienceDefinition,
  audiences: readonly string[],
): CatalogTree<AnyHttpController> {
  validateHttpControllerAudienceFilter(controllerAudiences, audiences);
  const selectedAudiences = new Set(audiences);
  const filteredCatalog = filterHttpControllerCatalogBranch(
    catalog,
    controllerAudiences,
    selectedAudiences,
  );

  validateHttpControllerCatalog(filteredCatalog);

  return filteredCatalog;
}

function filterHttpControllerCatalogBranch(
  catalog: CatalogTree<AnyHttpController>,
  controllerAudiences: HttpControllerAudienceDefinition,
  selectedAudiences: ReadonlySet<string>,
): CatalogTree<AnyHttpController> {
  const filteredCatalog: Record<
    string,
    AnyHttpController | CatalogTree<AnyHttpController>
  > = {};

  for (const [name, value] of Object.entries(catalog)) {
    if (isHttpController(value)) {
      const audiences = resolveHttpControllerAudiences(
        value.audiences,
        controllerAudiences,
      );

      if (
        audiences.some(
          (audience) => selectedAudiences.has(audience),
        )
      ) {
        filteredCatalog[name] = value;
      }

      continue;
    }

    const filteredBranch = filterHttpControllerCatalogBranch(
      value,
      controllerAudiences,
      selectedAudiences,
    );

    if (Object.keys(filteredBranch).length > 0) {
      filteredCatalog[name] = filteredBranch;
    }
  }

  return filteredCatalog;
}

/** Rejects identities that would make a filtered catalog ambiguous. */
export function validateHttpControllerCatalog(
  catalog: CatalogTree<AnyHttpController>,
): void {
  const operationPaths = new Map<string, string>();
  const clientPaths = new Set<string>();

  visitHttpControllerCatalog(catalog, [], (controller, path) => {
    const clientPath = path.join(".");
    const previousOperationPath = operationPaths.get(
      controller.operationId,
    );

    if (previousOperationPath !== undefined) {
      throw new TypeError(
        `Duplicate HTTP operation identifier ${controller.operationId}: ${previousOperationPath} and ${clientPath}.`,
      );
    }

    if (clientPaths.has(clientPath)) {
      throw new TypeError(
        `Conflicting HTTP controller catalog path: ${clientPath}.`,
      );
    }

    operationPaths.set(controller.operationId, clientPath);
    clientPaths.add(clientPath);
  });
}

function visitHttpControllerCatalog(
  catalog: CatalogTree<AnyHttpController>,
  parentPath: readonly string[],
  visit: (
    controller: AnyHttpController,
    path: readonly string[],
  ) => void,
): void {
  for (const [name, value] of Object.entries(catalog)) {
    const path = [...parentPath, name];

    if (isHttpController(value)) {
      visit(value, path);
    } else {
      visitHttpControllerCatalog(value, path, visit);
    }
  }
}
