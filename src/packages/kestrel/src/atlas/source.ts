import {
  type input,
  type output,
  type ZodType,
  z,
} from "zod";

import {
  parseSchema,
  resolveValidation,
  type DefinitionValidation,
  type ValidationMode,
} from "../definitions/index.js";
import type { HttpController } from "../http/index.js";
import type {
  AnyAction,
  AnyHttpController,
  AnyWorker,
  CatalogTree,
} from "../utils/index.js";
import {
  flattenCatalog,
  isAction,
  isHttpController,
  isWorker,
} from "../utils/index.js";
import type {
  AtlasClientEffect,
  AtlasOperationEffect,
  AtlasOperationResponse,
} from "./contract.js";
import { atlasClientEffectSchema } from "./effects.js";
import {
  atlasCollectionQuerySchema,
  mapAtlasCollectionQueryToCatalog,
} from "./collection.js";

type MaybePromise<Value> = Value | Promise<Value>;

/** HTTP controller contract safe to expose through the JSON operation gateway. */
export type AtlasHttpController = HttpController<
  any,
  any,
  any,
  any,
  ZodType,
  any
>;

export type CatalogAtlasQueryOperation =
  | AnyAction
  | AtlasHttpController;

export type CatalogAtlasOperation =
  | CatalogAtlasQueryOperation
  | AnyWorker;

export const atlasWorkerEnqueueResultSchema = z.object({
  jobId: z.string(),
});

type CatalogOperationInputSchema<Operation> =
  Operation extends { inputSchema: infer InputSchema extends ZodType }
    ? InputSchema
    : never;

type CatalogOperationOutputSchema<Operation> =
  Operation extends AnyWorker
    ? typeof atlasWorkerEnqueueResultSchema
    : Operation extends { outputSchema: infer OutputSchema extends ZodType }
      ? OutputSchema
      : never;

/** Executes an allowlisted catalog definition inside the current gateway scope. */
export interface CatalogAtlasOperationExecutor {
  execute(
    operation: CatalogAtlasOperation,
    input: unknown,
  ): Promise<unknown>;
}

/** A typed public exposure compiled independently from its catalog transport. */
export interface AtlasOperationReference<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType = ZodType,
  Operation extends CatalogAtlasOperation = CatalogAtlasOperation,
> {
  readonly sourceId: string;
  readonly operation: Operation;
  readonly effect: AtlasOperationEffect;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly validation: DefinitionValidation;
  derive<
    DerivedInputSchema extends ZodType,
    DerivedOutputSchema extends ZodType,
  >(
    transform: AtlasOperationDerivation<
      InputSchema,
      OutputSchema,
      DerivedInputSchema,
      DerivedOutputSchema
    >,
  ): AtlasOperationReference<
    DerivedInputSchema,
    DerivedOutputSchema,
    Operation
  >;
  mapInput<DerivedInputSchema extends ZodType>(
    inputSchema: DerivedInputSchema,
    mapInput: (
      input: output<DerivedInputSchema>,
    ) => MaybePromise<input<InputSchema>>,
    validation?: ValidationMode,
  ): AtlasOperationReference<
    DerivedInputSchema,
    OutputSchema,
    Operation
  >;
  mapOutput<DerivedOutputSchema extends ZodType>(
    outputSchema: DerivedOutputSchema,
    mapOutput: (
      output: output<OutputSchema>,
    ) => MaybePromise<input<DerivedOutputSchema>>,
    validation?: ValidationMode,
  ): AtlasOperationReference<
    InputSchema,
    DerivedOutputSchema,
    Operation
  >;
  onSuccess(
    run: (context: {
      readonly input: output<InputSchema>;
      readonly output: output<OutputSchema>;
    }) => SuccessGenerator<input<OutputSchema>>,
  ): AtlasOperationReference<InputSchema, OutputSchema, Operation>;
  execute(
    input: output<InputSchema>,
    executor: CatalogAtlasOperationExecutor,
  ): Promise<AtlasOperationResponse<output<OutputSchema>>>;
}

/** Transforms both public boundaries while retaining the catalog operation. */
export interface AtlasOperationDerivation<
  SourceInputSchema extends ZodType,
  SourceOutputSchema extends ZodType,
  DerivedInputSchema extends ZodType,
  DerivedOutputSchema extends ZodType,
> {
  <Operation extends CatalogAtlasOperation>(
    reference: AtlasOperationReference<
      SourceInputSchema,
      SourceOutputSchema,
      Operation
    >,
  ): AtlasOperationReference<
    DerivedInputSchema,
    DerivedOutputSchema,
    Operation
  >;
}

type SuccessGenerator<Response> =
  | Generator<AtlasClientEffect, Response | void, void>
  | AsyncGenerator<AtlasClientEffect, Response | void, void>;

export interface CatalogAtlasSource {
  readonly id: string;
  query<Operation extends CatalogAtlasQueryOperation>(
    operation: Operation,
  ): AtlasOperationReference<
    CatalogOperationInputSchema<Operation>,
    CatalogOperationOutputSchema<Operation>,
    Operation
  >;
  collectionQuery<Operation extends CatalogAtlasQueryOperation>(
    operation: Operation,
  ): AtlasOperationReference<
    typeof atlasCollectionQuerySchema,
    CatalogOperationOutputSchema<Operation>,
    Operation
  >;
  action<Operation extends CatalogAtlasOperation>(
    operation: Operation,
  ): AtlasOperationReference<
    CatalogOperationInputSchema<Operation>,
    CatalogOperationOutputSchema<Operation>,
    Operation
  >;
}

export interface CatalogAtlasSourceOptions {
  readonly id: string;
  readonly actions?: CatalogTree<AnyAction>;
  readonly httpControllers?: CatalogTree<AnyHttpController>;
  readonly workers?: CatalogTree<AnyWorker>;
}

/**
 * Replaces an exposure input and validates the mapped catalog-facing value.
 */
export function mapAtlasOperationInput<
  DerivedInputSchema extends ZodType,
  MappedInput,
>(
  inputSchema: DerivedInputSchema,
  mapInput: (
    input: output<DerivedInputSchema>,
  ) => MaybePromise<MappedInput>,
  validation: ValidationMode = "sync",
) {
  return <
    SourceInputSchema extends ZodType,
    OutputSchema extends ZodType,
    Operation extends CatalogAtlasOperation,
  >(
    reference: AtlasOperationReference<
      SourceInputSchema,
      OutputSchema,
      Operation
    > & (
      Awaited<MappedInput> extends input<SourceInputSchema>
        ? unknown
        : never
    ),
  ): AtlasOperationReference<
    DerivedInputSchema,
    OutputSchema,
    Operation
  > => createOperationReference<
    DerivedInputSchema,
    OutputSchema,
    Operation
  >({
    sourceId: reference.sourceId,
    operation: reference.operation,
    effect: reference.effect,
    inputSchema,
    outputSchema: reference.outputSchema,
    validation: resolveValidation({ input: validation, output: reference.validation.output }),
    execute: async (publicInput, executor) => {
      const mappedInput = await mapInput(publicInput);
      const parsedInput = await parseSchema(
        reference.inputSchema,
        mappedInput,
        reference.validation.input,
      );

      return reference.execute(parsedInput, executor);
    },
  });
}

/** Replaces an exposure output after the inner operation has succeeded. */
export function mapAtlasOperationOutput<
  DerivedOutputSchema extends ZodType,
  MappedOutput,
>(
  outputSchema: DerivedOutputSchema,
  mapOutput: (output: unknown) => MaybePromise<MappedOutput>,
  validation: ValidationMode = "sync",
) {
  return <
    InputSchema extends ZodType,
    SourceOutputSchema extends ZodType,
    Operation extends CatalogAtlasOperation,
  >(
    reference: AtlasOperationReference<
      InputSchema,
      SourceOutputSchema,
      Operation
    > & (
      Awaited<MappedOutput> extends input<DerivedOutputSchema>
        ? unknown
        : never
    ),
  ): AtlasOperationReference<
    InputSchema,
    DerivedOutputSchema,
    Operation
  > => createOperationReference<
    InputSchema,
    DerivedOutputSchema,
    Operation
  >({
    sourceId: reference.sourceId,
    operation: reference.operation,
    effect: reference.effect,
    inputSchema: reference.inputSchema,
    outputSchema,
    validation: resolveValidation({ input: reference.validation.input, output: validation }),
    execute: async (publicInput, executor) => {
      const result = await reference.execute(
        publicInput,
        executor,
      );
      const mappedOutput = await mapOutput(result.data);
      const parsedOutput = await parseSchema(outputSchema, mappedOutput, validation);

      return { data: parsedOutput, effects: result.effects };
    },
  });
}

/** Adds validated client effects while preserving the successful output. */
export function onAtlasOperationSuccess<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
>(
  run: (context: {
    readonly input: output<InputSchema>;
    readonly output: output<OutputSchema>;
  }) => SuccessGenerator<input<OutputSchema>>,
): AtlasOperationDerivation<
  InputSchema,
  OutputSchema,
  InputSchema,
  OutputSchema
> {
  return <Operation extends CatalogAtlasOperation>(
    reference: AtlasOperationReference<
      InputSchema,
      OutputSchema,
      Operation
    >,
  ) => createOperationReference<InputSchema, OutputSchema, Operation>({
    sourceId: reference.sourceId,
    operation: reference.operation,
    effect: reference.effect,
    inputSchema: reference.inputSchema,
    outputSchema: reference.outputSchema,
    validation: reference.validation,
    execute: async (publicInput, executor) => {
      const result = await reference.execute(
        publicInput,
        executor,
      );
      const generator = run({ input: publicInput, output: result.data });
      const effects = [...result.effects];
      let step = await generator.next();

      while (!step.done) {
        effects.push(
          atlasClientEffectSchema.parse(
            step.value,
          ) as AtlasClientEffect,
        );
        step = await generator.next();
      }

      const data = step.value === undefined ? result.data : step.value;
      const parsedOutput = await parseSchema(
        reference.outputSchema,
        data,
        reference.validation.output,
      );

      return { data: parsedOutput, effects };
    },
  });
}

/** Classifies explicitly catalogued definitions as atlas operations. */
export function defineCatalogAtlasSource(
  options: CatalogAtlasSourceOptions,
): CatalogAtlasSource {
  assertIdentifier(options.id, "source");

  const actions = new Set(flattenCatalog(options.actions ?? {}, isAction));
  const httpControllers = new Set(flattenCatalog(
    options.httpControllers ?? {},
    isHttpController,
  ));
  const workers = new Set(flattenCatalog(
    options.workers ?? {},
    isWorker,
  ));

  const reference = <Operation extends CatalogAtlasOperation>(
    operation: Operation,
    effect: AtlasOperationEffect,
  ): AtlasOperationReference<
    CatalogOperationInputSchema<Operation>,
    CatalogOperationOutputSchema<Operation>,
    Operation
  > => {
    if (
      !actions.has(operation as AnyAction)
      && !httpControllers.has(operation as AnyHttpController)
      && !workers.has(operation as AnyWorker)
    ) {
      throw new TypeError(
        `Atlas source "${options.id}" cannot reference an operation outside its catalog.`,
      );
    }

    if (isHttpController(operation) && operation.outputSchema === undefined) {
      throw new TypeError(
        `Atlas source "${options.id}" requires HTTP controller "${operation.operationId}" to declare an output schema.`,
      );
    }

    const outputSchema = isWorker(operation)
      ? atlasWorkerEnqueueResultSchema
      : operation.outputSchema;

    return createOperationReference({
      sourceId: options.id,
      operation,
      effect,
      inputSchema: operation.inputSchema,
      outputSchema: outputSchema as CatalogOperationOutputSchema<Operation>,
      validation: operation.validation,
      execute: async (input, executor) => {
        const parsedInput = await parseSchema(
          operation.inputSchema,
          input,
          operation.validation.input,
        );
        const output = await executor.execute(operation, parsedInput);
        const parsedOutput = await parseSchema(
          outputSchema,
          output,
          operation.validation.output,
        );

        return { data: parsedOutput, effects: [] };
      },
    });
  };

  return {
    id: options.id,
    query: (operation) => reference(operation, "read"),
    collectionQuery: (operation) => {
      const inner = reference(operation, "read");

      // Collection compatibility is validated against the selected operation
      // schema while preserving the source-independent public input contract.
      return createOperationReference({
        sourceId: inner.sourceId,
        operation: inner.operation,
        effect: inner.effect,
        inputSchema: atlasCollectionQuerySchema,
        outputSchema: inner.outputSchema,
        validation: resolveValidation({ output: inner.validation.output }),
        execute: async (publicInput, executor) => {
          const mappedInput = mapAtlasCollectionQueryToCatalog(
            publicInput,
          );
          const parsedInput = await parseSchema(
            inner.inputSchema,
            mappedInput,
            inner.validation.input,
          );

          return inner.execute(parsedInput, executor);
        },
      });
    },
    action: (operation) => reference(operation, "write"),
  };
}

function createOperationReference<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Operation extends CatalogAtlasOperation,
>(options: Omit<
  AtlasOperationReference<InputSchema, OutputSchema, Operation>,
  "derive" | "mapInput" | "mapOutput" | "onSuccess"
>): AtlasOperationReference<InputSchema, OutputSchema, Operation> {
  const reference: AtlasOperationReference<
    InputSchema,
    OutputSchema,
    Operation
  > = {
    ...options,
    derive: (transform) => transform(reference),
    mapInput: (inputSchema, mapInput, validation = "sync") => createOperationReference({
      sourceId: reference.sourceId,
      operation: reference.operation,
      effect: reference.effect,
      inputSchema,
      outputSchema: reference.outputSchema,
      validation: resolveValidation({ input: validation, output: reference.validation.output }),
      execute: async (publicInput, executor) => {
        const mappedInput = await mapInput(publicInput);
        const parsedInput = await parseSchema(
          reference.inputSchema,
          mappedInput,
          reference.validation.input,
        );

        return reference.execute(parsedInput, executor);
      },
    }),
    mapOutput: (outputSchema, mapOutput, validation = "sync") => mapReferenceOutput(
      reference,
      outputSchema,
      mapOutput,
      validation,
    ),
    onSuccess: (run) => onAtlasOperationSuccess<
      InputSchema,
      OutputSchema
    >(run)(reference),
  };

  return reference;
}

function mapReferenceOutput<
  InputSchema extends ZodType,
  SourceOutputSchema extends ZodType,
  DerivedOutputSchema extends ZodType,
  Operation extends CatalogAtlasOperation,
>(
  reference: AtlasOperationReference<
    InputSchema,
    SourceOutputSchema,
    Operation
  >,
  outputSchema: DerivedOutputSchema,
  mapOutput: (
    output: output<SourceOutputSchema>,
  ) => MaybePromise<input<DerivedOutputSchema>>,
  validation: ValidationMode = "sync",
): AtlasOperationReference<InputSchema, DerivedOutputSchema, Operation> {
  return createOperationReference<
    InputSchema,
    DerivedOutputSchema,
    Operation
  >({
    sourceId: reference.sourceId,
    operation: reference.operation,
    effect: reference.effect,
    inputSchema: reference.inputSchema,
    outputSchema,
    validation: resolveValidation({ input: reference.validation.input, output: validation }),
    execute: async (publicInput, executor) => {
      const result = await reference.execute(
        publicInput,
        executor,
      );
      const mappedOutput = await mapOutput(result.data);
      const parsedOutput = await parseSchema(outputSchema, mappedOutput, validation);

      return { data: parsedOutput, effects: result.effects };
    },
  });
}

/** Validates identifiers shared by source, resource and operation manifests. */
export function assertIdentifier(value: string, kind: string): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(
      `Atlas ${kind} id "${value}" must use lowercase kebab-case.`,
    );
  }
}
