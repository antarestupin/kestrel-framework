import {
  z,
  type input,
  type output,
  type ZodType,
} from "zod";

import type {
  CollectionQuery,
  PaginatedResult,
  RepositoryReturningOptions,
} from "../db/index.js";
import type { Constructor } from "../di/index.js";
import { defineAction } from "./action.js";
import {
  createPaginatedOutputSchema,
} from "./pagination.js";
import { createCollectionQueryInputSchema } from "./collection.js";

type IdentifierInput<IdentifierKey extends string> = Record<
  IdentifierKey,
  unknown
>;

/**
 * Describes the repository operation required by a create action.
 */
export interface ModelCreateActionRepository<
  Model,
  CreateInput,
> {
  create(
    input: CreateInput,
    options: RepositoryReturningOptions<true>,
  ): Promise<Model>;
}

/**
 * Describes the repository operation required by a get action.
 */
export interface ModelGetActionRepository<Model, Identifier> {
  findById(id: Identifier): Promise<Model | null>;
}

/**
 * Describes the repository operation required by a get-many action.
 */
export interface ModelGetManyActionRepository<Model, Identifier> {
  findManyByIds(ids: readonly Identifier[]): Promise<Model[]>;
}

/**
 * Describes the repository operation required by a list action.
 */
export interface ModelListActionRepository<Model> {
  findCollection(
    query: CollectionQuery,
  ): Promise<PaginatedResult<Model, CollectionQuery["pagination"]>>;
}

/**
 * Describes the repository operation required by an update action.
 */
export interface ModelUpdateActionRepository<
  Model,
  Identifier,
  UpdateInput,
> {
  update(
    id: Identifier,
    input: UpdateInput,
    options: RepositoryReturningOptions<true>,
  ): Promise<Model | null>;
}

/**
 * Describes the repository operation required by a delete action.
 */
export interface ModelDeleteActionRepository<Model, Identifier> {
  delete(
    id: Identifier,
    options: RepositoryReturningOptions<true>,
  ): Promise<Model | null>;
}

/**
 * Describes all repository operations required by the base action set.
 */
export interface ModelActionRepository<
  Model,
  CreateInput,
  Identifier,
  UpdateInput = Partial<CreateInput>,
> extends
    ModelCreateActionRepository<Model, CreateInput>,
    ModelGetActionRepository<Model, Identifier>,
    ModelGetManyActionRepository<Model, Identifier>,
    ModelListActionRepository<Model>,
    ModelUpdateActionRepository<Model, Identifier, UpdateInput>,
    ModelDeleteActionRepository<Model, Identifier> {}

/**
 * Defines the conventional create action for a repository-backed model.
 */
export function defineModelCreateAction<
  CreateInputSchema extends ZodType,
  OutputSchema extends ZodType,
  Repository extends ModelCreateActionRepository<
    input<OutputSchema>,
    output<CreateInputSchema>
  >,
>(
  modelName: string,
  repository: Constructor<Repository>,
  inputSchema: CreateInputSchema,
  outputSchema: OutputSchema,
) {
  return defineAction({
    name: `${modelName}.create`,
    input: inputSchema,
    output: outputSchema,
    description: `Create a ${modelName}.`,
    dependencies: { repository },
    handler: (input, { repository: resolvedRepository }) =>
      resolvedRepository.create(input, { returning: true }),
  });
}

/**
 * Defines the conventional get-by-id action for a repository-backed model.
 */
export function defineModelGetAction<
  const IdentifierKey extends string,
  IdentifierInputSchema extends ZodType<
    IdentifierInput<IdentifierKey>
  >,
  OutputSchema extends ZodType<
    IdentifierInput<IdentifierKey>
  >,
  Repository extends ModelGetActionRepository<
    input<OutputSchema>,
    output<IdentifierInputSchema>[IdentifierKey]
  >,
>(
  modelName: string,
  repository: Constructor<Repository>,
  identifierKey: IdentifierKey,
  inputSchema: IdentifierInputSchema,
  outputSchema: OutputSchema,
) {
  return defineAction({
    name: `${modelName}.get`,
    input: inputSchema,
    output: outputSchema.nullable(),
    description: `Get a ${modelName} by id.`,
    dependencies: { repository },
    handler: (input, { repository: resolvedRepository }) =>
      resolvedRepository.findById(input[identifierKey]),
  });
}

/**
 * Defines the conventional get-many-by-id action for a repository-backed model.
 */
export function defineModelGetManyAction<
  IdentifierInputSchema extends ZodType<{ ids: unknown[] }>,
  OutputSchema extends ZodType,
  Repository extends ModelGetManyActionRepository<
    input<OutputSchema>,
    output<IdentifierInputSchema>["ids"][number]
  >,
>(
  modelName: string,
  repository: Constructor<Repository>,
  inputSchema: IdentifierInputSchema,
  outputSchema: OutputSchema,
) {
  return defineAction({
    name: `${modelName}.getMany`,
    input: inputSchema,
    output: z.array(outputSchema),
    description: `Get multiple ${modelName} models by id.`,
    dependencies: { repository },
    handler: (input, { repository: resolvedRepository }) =>
      resolvedRepository.findManyByIds(input.ids),
  });
}

/**
 * Defines the conventional paginated list action for a repository-backed model.
 */
export function defineModelListAction<
  ModelOutputSchema extends ZodType,
>(
  modelName: string,
  repository: Constructor<
    ModelListActionRepository<input<ModelOutputSchema>>
  >,
  modelOutputSchema: ModelOutputSchema,
) {
  return defineModelCollectionAction(
    `${modelName}.list`,
    `List ${modelName} models.`,
    repository,
    modelOutputSchema,
  );
}

/**
 * Defines an optional model-backed candidate Query for specialized relations.
 */
export function defineModelLookupAction<
  ModelOutputSchema extends ZodType,
>(
  modelName: string,
  repository: Constructor<
    ModelListActionRepository<input<ModelOutputSchema>>
  >,
  modelOutputSchema: ModelOutputSchema,
) {
  return defineModelCollectionAction(
    `${modelName}.lookup`,
    `Look up ${modelName} relation candidates.`,
    repository,
    modelOutputSchema,
  );
}

function defineModelCollectionAction<
  ModelOutputSchema extends ZodType,
>(
  name: string,
  description: string,
  repository: Constructor<
    ModelListActionRepository<input<ModelOutputSchema>>
  >,
  modelOutputSchema: ModelOutputSchema,
) {
  const inputSchema = createCollectionQueryInputSchema();
  const outputSchema =
    createPaginatedOutputSchema(modelOutputSchema);

  return defineAction({
    name,
    input: inputSchema,
    output: outputSchema,
    description,
    dependencies: { repository },
    handler: (
      input,
      { repository: resolvedRepository },
    ) => resolvedRepository.findCollection(input),
  });
}

/**
 * Defines the conventional update-by-id action for a repository-backed model.
 */
export function defineModelUpdateAction<
  const IdentifierKey extends string,
  UpdateInputSchema extends ZodType<IdentifierInput<IdentifierKey>>,
  OutputSchema extends ZodType<IdentifierInput<IdentifierKey>>,
  Repository extends ModelUpdateActionRepository<
    input<OutputSchema>,
    output<UpdateInputSchema>[IdentifierKey],
    Omit<output<UpdateInputSchema>, IdentifierKey>
  >,
>(
  modelName: string,
  repository: Constructor<Repository>,
  identifierKey: IdentifierKey,
  inputSchema: UpdateInputSchema,
  outputSchema: OutputSchema,
) {
  return defineAction({
    name: `${modelName}.update`,
    input: inputSchema,
    output: outputSchema.nullable(),
    description: `Update a ${modelName} by id.`,
    dependencies: { repository },
    handler: (input, { repository: resolvedRepository }) => {
      // The identifier selects the record and must not enter its update set.
      const {
        [identifierKey]: identifier,
        ...update
      } = input;

      return resolvedRepository.update(
        identifier,
        update,
        { returning: true },
      );
    },
  });
}

/**
 * Defines the conventional delete-by-id action for a repository-backed model.
 */
export function defineModelDeleteAction<
  const IdentifierKey extends string,
  IdentifierInputSchema extends ZodType<
    IdentifierInput<IdentifierKey>
  >,
  OutputSchema extends ZodType<
    IdentifierInput<IdentifierKey>
  >,
  Repository extends ModelDeleteActionRepository<
    input<OutputSchema>,
    output<IdentifierInputSchema>[IdentifierKey]
  >,
>(
  modelName: string,
  repository: Constructor<Repository>,
  identifierKey: IdentifierKey,
  inputSchema: IdentifierInputSchema,
  outputSchema: OutputSchema,
) {
  return defineAction({
    name: `${modelName}.delete`,
    input: inputSchema,
    output: outputSchema.nullable(),
    description: `Delete a ${modelName} by id.`,
    dependencies: { repository },
    handler: (input, { repository: resolvedRepository }) =>
      resolvedRepository.delete(
        input[identifierKey],
        { returning: true },
      ),
  });
}
