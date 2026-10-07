import { safeParseSchema } from "../definitions/index.js";
import {
  defineHttpAccessPolicy,
  defineHttpController,
  executeHttpController,
  get,
  post,
  type HttpControllerExecutionContext,
  type HttpMiddleware,
} from "../http/index.js";
import {
  isAction,
  isHttpController,
  isWorker,
  type AnyHttpController,
} from "../utils/index.js";
import { workerClientDependency } from "../workers/index.js";
import { z, type ZodType } from "zod";
import type {
  AtlasManifest,
  AtlasNotificationPosition,
  AtlasRelatedCollectionManifest,
  AtlasRelatedRecordsFeaturesManifest,
  AtlasRecordActionsInList,
} from "./contract.js";
import { IconCatalogBuilder } from "./icon_catalog.js";
import type {
  AtlasHttpController,
  AtlasOperationReference,
  CatalogAtlasOperationExecutor,
} from "./source.js";
import type {
  AtlasRecordAction,
  AtlasResource,
} from "./resource.js";
import { createResourceCollectionQuerySchema } from "./collection.js";

interface RecordActionInvocation {
  readonly resourceId: string;
  readonly actionId: string;
  readonly action: AtlasRecordAction;
}

interface OperationInvocation {
  readonly inputSchema: ZodType;
  readonly reference: AtlasOperationReference;
}

export const DEFAULT_ATLAS_BASE_PATH = "/atlas";

/** Defaults inherited by Resources and their controls. */
export interface AtlasDefaultsOptions {
  readonly recordActionsInList?: AtlasRecordActionsInList;
}

export interface AtlasNotificationsOptions {
  readonly position?: AtlasNotificationPosition;
}

export interface AtlasOptions {
  readonly title?: string;
  readonly basePath?: string;
  readonly defaults?: AtlasDefaultsOptions;
  readonly notifications?: AtlasNotificationsOptions;
  readonly resources: readonly AtlasResource[];
}

/** Middleware applied by the provider to the complete Atlas boundary. */
export interface AtlasHttpMiddlewareOptions {
  readonly required?: readonly HttpMiddleware<any, any>[];
  readonly unsafe?: readonly HttpMiddleware<any, any>[];
}

/** Owns one Atlas definition and compiles its client manifest. */
export class Atlas {
  public readonly basePath: string;
  public readonly title: string;
  public readonly defaults: Required<AtlasDefaultsOptions>;
  public readonly notifications: Required<AtlasNotificationsOptions>;
  public readonly resources: readonly AtlasResource[];
  private readonly operations: ReadonlyMap<string, OperationInvocation>;
  private readonly recordActions: ReadonlyMap<string, RecordActionInvocation>;
  private manifest?: AtlasManifest;

  public constructor(options: AtlasOptions) {
    this.basePath = normalizeBasePath(
      options.basePath ?? DEFAULT_ATLAS_BASE_PATH,
    );
    this.title = options.title?.trim() || "Atlas";
    this.defaults = {
      recordActionsInList: options.defaults?.recordActionsInList ?? "all",
    };
    this.notifications = {
      position: options.notifications?.position ?? "bottom-left",
    };
    this.resources = [...options.resources];

    const resourceIds = new Set<string>();

    for (const resource of this.resources) {
      if (resourceIds.has(resource.id)) {
        throw new TypeError(
          `Atlas resource id "${resource.id}" is registered more than once.`,
        );
      }

      resourceIds.add(resource.id);
    }

    // Compile the manifest first so relation lookup exposures can inherit the
    // field allowlist of their target Resource, including cross-source targets.
    this.operations = compileOperationAllowlist(
      this.resources,
      this.getManifest().resources,
    );
    this.recordActions = compileRecordActionAllowlist(this.resources);
  }

  /** Returns the serializable configuration loaded by the React client. */
  public getManifest(): AtlasManifest {
    if (this.manifest !== undefined) {
      return this.manifest;
    }

    const icons = new IconCatalogBuilder();
    const compiledResources = this.resources.map((resource) => ({
      ...resource.toManifest(),
      ...(resource.icon === undefined
        ? {}
        : { icon: icons.add(resource.icon) }),
    }));

    validateResourceRelations(compiledResources);
    const resources = compileRelatedCollections(compiledResources);

    this.manifest = {
      basePath: this.basePath,
      title: this.title,
      defaults: this.defaults,
      notifications: this.notifications,
      icons: icons.toManifest(),
      resources,
    };
    return this.manifest;
  }

  /** Defines the JSON endpoints owned by Atlas runtime. */
  public defineHttpControllers(
    middleware: AtlasHttpMiddlewareOptions = {},
  ): readonly AnyHttpController[] {
    const required = middleware.required ?? [];
    const unsafe = [...(middleware.unsafe ?? []), ...required];
    const requiredAccess = defineHttpAccessPolicy(
      "atlas.http.required",
      required,
    );
    const unsafeAccess = defineHttpAccessPolicy(
      "atlas.http.unsafe",
      unsafe,
    );

    return [
      defineHttpController({
        access: requiredAccess,
        route: get(joinAtlasPath(this.basePath, "/api/manifest")),
        description: "Expose Atlas client manifest.",
        handler: () => this.getManifest(),
      }),
      defineHttpController({
        access: unsafeAccess,
        route: post(joinAtlasPath(
          this.basePath,
          "/api/operations/:operationId",
        )),
        description: "Execute one operation exposed by Atlas manifest.",
        input: z.object({
          operationId: z.string().min(1),
          input: z.unknown(),
        }),
        output: z.unknown(),
        successStatusCode: 200,
        handler: async ({ input, execution, reply, request, defaultAccess }) => {
          const invocation = this.operations.get(input.operationId);

          if (invocation === undefined) {
            return reply.code(404).send({
              error: "Atlas operation not found.",
            });
          }

          // Validate at the gateway boundary so invalid business input remains
          // a caller error while handler and output failures stay server errors.
          const parsedInput = await safeParseSchema(
            invocation.inputSchema, input.input, invocation.reference.validation.input,
          );

          if (!parsedInput.success) {
            return reply.code(400).send({
              statusCode: 400,
              error: "Bad Request",
              message: "The request input is invalid.",
              issues: parsedInput.error.issues,
            });
          }

          return invocation.reference.execute(
            parsedInput.data,
            createCatalogOperationExecutor({ execution, request, reply, defaultAccess }),
          );
        },
      }),
      defineHttpController({
        access: unsafeAccess,
        route: post(joinAtlasPath(
          this.basePath,
          "/api/resources/:resourceId/record-actions/:recordActionId",
        )),
        description: "Execute one Resource record Action through its configured exposure.",
        input: z.object({
          resourceId: z.string().min(1),
          recordActionId: z.string().min(1),
          input: z.unknown(),
        }),
        output: z.unknown(),
        successStatusCode: 200,
        handler: async ({ input, execution, reply, request, defaultAccess }) => {
          const invocation = this.recordActions.get(
            getRecordActionKey(input.resourceId, input.recordActionId),
          );

          if (invocation === undefined) {
            return reply.code(404).send({
              error: "Atlas record Action not found.",
            });
          }

          const operation = invocation.action.action;
          const parsedInput = await safeParseSchema(
            operation.inputSchema, input.input, operation.validation.input,
          );

          if (!parsedInput.success) {
            return reply.code(400).send({
              statusCode: 400,
              error: "Bad Request",
              message: "The request input is invalid.",
              issues: parsedInput.error.issues,
            });
          }

          return operation.execute(
            parsedInput.data,
            createCatalogOperationExecutor({ execution, request, reply, defaultAccess }),
          );
        },
      }),
    ];
  }
}

/** Creates the request-scoped dispatcher used by catalog source references. */
function createCatalogOperationExecutor(
  context: HttpControllerExecutionContext,
): CatalogAtlasOperationExecutor {
  return {
    async execute(operation, input) {
      if (isAction(operation)) {
        return context.execution.get(operation).run(input);
      }

      if (isHttpController(operation)) {
        const output = await executeHttpController(
          operation as AtlasHttpController,
          input as never,
          context,
        );

        if (context.reply.sent) {
          throw new Error(
            `Atlas HTTP controller "${operation.operationId}" cannot send a reply directly.`,
          );
        }

        return output;
      }

      if (isWorker(operation)) {
        const { workerClient } = context.execution.resolveDependencies({
          workerClient: workerClientDependency,
        });
        const jobId = await workerClient.enqueue(operation, input);

        return { jobId };
      }

      throw new TypeError("Unsupported atlas catalog operation.");
    },
  };
}

/** Compiles incoming `many` relations into contextual record collections. */
function compileRelatedCollections(
  resources: AtlasManifest["resources"],
): AtlasManifest["resources"] {
  const collectionsByTarget = new Map<
    string,
    AtlasRelatedCollectionManifest[]
  >();

  for (const resource of resources) {
    for (const field of resource.fields) {
      const relation = field.relation;

      if (
        relation === undefined
        || (relation.inverseCardinality ?? "many") !== "many"
        || relation.relatedRecords === false
      ) {
        continue;
      }

      const configured = relation.relatedRecords;
      const features: AtlasRelatedRecordsFeaturesManifest =
        configured?.features ?? {
          search: true,
          filters: true,
          sorting: true,
          pagination: true,
          recordActions: true,
        };

      if (
        configured?.query === undefined
        && !field.filterOperators.includes("equals")
      ) {
        throw new TypeError(
          `Atlas inverse relation "${resource.id}.${field.id}" requires the "equals" filter or a related records Query.`,
        );
      }

      const collections = collectionsByTarget.get(relation.resource) ?? [];

      collections.push({
        id: `${resource.id}.${field.id}`,
        label: configured?.label ?? resource.label,
        resource: resource.id,
        field: field.id,
        pageSize: configured?.pageSize ?? 10,
        features,
        ...(configured?.query === undefined
          ? {}
          : { query: configured.query }),
        ...(configured?.recordInput === undefined
          ? {}
          : { recordInput: configured.recordInput }),
      });
      collectionsByTarget.set(relation.resource, collections);
    }
  }

  return resources.map((resource) => ({
    ...resource,
    relatedCollections: collectionsByTarget.get(resource.id) ?? [],
  }));
}

function validateResourceRelations(
  resources: AtlasManifest["resources"],
): void {
  const resourcesById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );

  for (const resource of resources) {
    const fields = [
      ...resource.fields.map((field) => ({
        field,
        path: `${resource.id}.${field.id}`,
      })),
      ...resource.recordActions.flatMap((action) =>
        (action.parameterFields ?? []).map((field) => ({
          field,
          path: `${resource.id}.${action.id}.${field.id}`,
        }))),
    ];

    for (const { field, path } of fields) {
      if (field.relation === undefined) {
        continue;
      }

      const target = resourcesById.get(field.relation.resource);

      if (target === undefined) {
        throw new TypeError(
          `Atlas relation field "${path}" references unknown Resource "${field.relation.resource}".`,
        );
      }

      if (
        (field.relation.lookup?.minimumSearchLength ?? 0) > 0
        && !target.fields.some((candidate) => candidate.searchable)
      ) {
        throw new TypeError(
          `Atlas relation field "${path}" requires searchable fields on target Resource "${target.id}".`,
        );
      }

      for (const displayField of [field.relation.displayField]) {
        if (
          displayField !== undefined
          && !target.fields.some((candidate) => candidate.id === displayField)
        ) {
            throw new TypeError(
            `Atlas relation field "${path}" references unknown target display field "${target.id}.${displayField}".`,
          );
        }
      }
    }
  }
}

function compileOperationAllowlist(
  resources: readonly AtlasResource[],
  manifests: readonly AtlasManifest["resources"][number][],
): ReadonlyMap<string, OperationInvocation> {
  const operations = new Map<string, OperationInvocation>();

  for (const exposure of resources.flatMap((resource) =>
    resource.getOperationExposures())) {
    if (operations.has(exposure.id)) {
      throw new TypeError(
        `Atlas operation exposure "${exposure.id}" is registered more than once.`,
      );
    }

    const collectionResource = exposure.collectionResourceId === undefined
      ? undefined
      : manifests.find((resource) =>
        resource.id === exposure.collectionResourceId);

    if (
      exposure.collectionResourceId !== undefined
      && collectionResource === undefined
    ) {
      throw new TypeError(
        `Atlas collection exposure "${exposure.id}" references unknown Resource "${exposure.collectionResourceId}".`,
      );
    }

    operations.set(exposure.id, {
      inputSchema: collectionResource === undefined
        ? exposure.inputSchema
        : createResourceCollectionQuerySchema(
          collectionResource.fields,
          exposure.collectionConstraints,
        ),
      reference: exposure.reference,
    });
  }

  return operations;
}

function compileRecordActionAllowlist(
  resources: readonly AtlasResource[],
): ReadonlyMap<string, RecordActionInvocation> {
  const actions = new Map<string, RecordActionInvocation>();

  for (const resource of resources) {
    for (const [actionId, action] of Object.entries(
      resource.getRecordActions(),
    )) {
      const invocation = { resourceId: resource.id, actionId, action };

      actions.set(
        getRecordActionKey(invocation.resourceId, invocation.actionId),
        invocation,
      );
    }
  }

  return actions;
}

function getRecordActionKey(resourceId: string, actionId: string): string {
  return `${resourceId}/${actionId}`;
}

/** Defines an Atlas with a small functional API. */
export function defineAtlas(options: AtlasOptions): Atlas {
  return new Atlas(options);
}

/** Joins an internal atlas route to its configurable base path. */
export function joinAtlasPath(
  basePath: string,
  relativePath: `/${string}`,
): string {
  return basePath === "/" ? relativePath : `${basePath}${relativePath}`;
}

function normalizeBasePath(basePath: string): string {
  const trimmedPath = basePath.trim();

  if (
    !trimmedPath.startsWith("/")
    || trimmedPath.includes("?")
    || trimmedPath.includes("#")
    || trimmedPath.includes("*")
  ) {
    throw new TypeError(
      "Atlas base path must be an absolute URL path without a query, fragment or wildcard.",
    );
  }

  return trimmedPath === "/"
    ? trimmedPath
    : trimmedPath.replace(/\/+$/u, "");
}
