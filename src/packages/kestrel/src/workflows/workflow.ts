import {
  type input,
  type output,
  z,
  type ZodType,
} from "zod";

import {
  resolveValidation,
  type DefinitionValidation,
  type ValidationOptions,
} from "../definitions/index.js";
import type {
  AnyWorkflowSignal,
  WorkflowSignal,
} from "./signal.js";
import { validateWorkflowName } from "./signal.js";
import type { WorkflowExecutionContext } from "./context.js";
import {
  validateWorkflowConcurrency,
  type WorkflowConcurrencyOptions,
} from "./concurrency.js";

const nullWorkflowInputSchema = z.null();

export interface WorkflowVersionOptions {
  /** Version assigned to newly started executions. */
  current: number;
  /** Oldest execution version the current handler can still replay. */
  supportedFrom?: number;
}

export interface ResolvedWorkflowVersion {
  readonly current: number;
  readonly supportedFrom: number;
}

export interface WorkflowExample<InputSchema extends ZodType> {
  name?: string;
  input: input<InputSchema>;
}

export type WorkflowOutput<OutputSchema extends ZodType | undefined> =
  OutputSchema extends ZodType ? output<OutputSchema> : void;

type WorkflowHandlerOutput<OutputSchema extends ZodType | undefined> =
  OutputSchema extends ZodType ? input<OutputSchema> : void;

export interface WorkflowOptions<
  InputSchema extends ZodType = typeof nullWorkflowInputSchema,
  OutputSchema extends ZodType | undefined = undefined,
  Signals extends readonly AnyWorkflowSignal[] = readonly [],
> {
  name: string;
  description?: string;
  version?: WorkflowVersionOptions;
  input?: InputSchema;
  /** Omitted validation modes use synchronous parsing. */
  validation?: ValidationOptions;
  output?: OutputSchema;
  examples?: readonly WorkflowExample<InputSchema>[];
  signals?: Signals;
  concurrency?: WorkflowConcurrencyOptions<output<InputSchema>>;
  handler: (
    input: output<InputSchema>,
    context: WorkflowExecutionContext<Signals, input<InputSchema>>,
  ) =>
    | Promise<WorkflowHandlerOutput<OutputSchema>>
    | WorkflowHandlerOutput<OutputSchema>;
}

/** Catalog definition retaining workflow schemas and interaction contracts. */
export interface Workflow<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType | undefined = ZodType | undefined,
  Signals extends readonly AnyWorkflowSignal[] = readonly AnyWorkflowSignal[],
> {
  readonly kind: "workflow";
  readonly name: string;
  readonly description?: string;
  readonly version: ResolvedWorkflowVersion;
  readonly inputSchema: InputSchema;
  readonly validation: DefinitionValidation;
  readonly outputSchema?: OutputSchema;
  readonly examples?: readonly WorkflowExample<InputSchema>[];
  readonly signals: Signals;
  readonly concurrency?: WorkflowConcurrencyOptions<output<InputSchema>>;
  readonly handler: WorkflowOptions<
    InputSchema,
    OutputSchema,
    Signals
  >["handler"];
}

export type AnyWorkflow = Workflow<
  ZodType,
  ZodType | undefined,
  readonly AnyWorkflowSignal[]
>;

export type WorkflowInput<Definition extends AnyWorkflow> =
  Definition extends Workflow<infer InputSchema, any, any>
    ? input<InputSchema>
    : never;

export type WorkflowResult<Definition extends AnyWorkflow> =
  Definition extends Workflow<any, infer OutputSchema, any>
    ? WorkflowOutput<OutputSchema>
    : never;

export type WorkflowSignals<Definition extends AnyWorkflow> =
  Definition extends Workflow<any, any, infer Signals>
    ? Signals[number]
    : never;

/** Defines one typed, versioned durable workflow. */
export function defineWorkflow<
  InputSchema extends ZodType = typeof nullWorkflowInputSchema,
  OutputSchema extends ZodType | undefined = undefined,
  const Signals extends readonly AnyWorkflowSignal[] = readonly [],
>(
  options: WorkflowOptions<InputSchema, OutputSchema, Signals>,
): Workflow<InputSchema, OutputSchema, Signals> {
  validateWorkflowName("workflow", options.name);
  const version = resolveWorkflowVersion(options.version);
  const signals = [...(options.signals ?? [])] as unknown as Signals;
  validateSignals(signals);
  validateWorkflowConcurrency(options.concurrency);

  return {
    kind: "workflow",
    name: options.name,
    validation: resolveValidation(options.validation),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    version,
    inputSchema: options.input
      ?? nullWorkflowInputSchema as unknown as InputSchema,
    ...(options.output === undefined
      ? {}
      : { outputSchema: options.output }),
    ...(options.examples === undefined
      ? {}
      : { examples: options.examples }),
    signals,
    ...(options.concurrency === undefined
      ? {}
      : { concurrency: options.concurrency }),
    handler: options.handler,
  };
}

function resolveWorkflowVersion(
  options: WorkflowVersionOptions | undefined,
): ResolvedWorkflowVersion {
  const current = options?.current ?? 1;
  const supportedFrom = options?.supportedFrom ?? current;

  if (!Number.isSafeInteger(current) || current < 1) {
    throw new TypeError("Workflow current version must be a positive integer.");
  }

  if (!Number.isSafeInteger(supportedFrom) || supportedFrom < 1) {
    throw new TypeError(
      "Workflow oldest supported version must be a positive integer.",
    );
  }

  if (supportedFrom > current) {
    throw new TypeError(
      "Workflow oldest supported version cannot exceed its current version.",
    );
  }

  return { current, supportedFrom };
}

function validateSignals(signals: readonly WorkflowSignal[]): void {
  const names = new Set<string>();

  for (const signal of signals) {
    if (names.has(signal.name)) {
      throw new TypeError(
        `Workflow signal names must be unique within a workflow: "${signal.name}".`,
      );
    }

    names.add(signal.name);
  }
}
