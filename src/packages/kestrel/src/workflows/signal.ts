import {
  type input,
  type output,
  type ZodType,
} from "zod";

import {
  resolveValidation,
  type DefinitionValidation,
  type InputValidationOptions,
} from "../definitions/index.js";
/** Describes one typed external message accepted by a workflow. */
export interface WorkflowSignal<PayloadSchema extends ZodType = ZodType> {
  readonly kind: "workflow-signal";
  readonly name: string;
  readonly description?: string;
  readonly payloadSchema: PayloadSchema;
  readonly validation: DefinitionValidation;
}

export interface WorkflowSignalOptions<PayloadSchema extends ZodType> {
  /** Stable signal name persisted in workflow history. */
  name: string;
  description?: string;
  payload: PayloadSchema;
  /** Omitted validation modes use synchronous parsing. */
  validation?: InputValidationOptions;
}

export type AnyWorkflowSignal = WorkflowSignal<ZodType>;

export type WorkflowSignalInput<Signal extends AnyWorkflowSignal> = input<
  Signal["payloadSchema"]
>;

export type WorkflowSignalPayload<Signal extends AnyWorkflowSignal> = output<
  Signal["payloadSchema"]
>;

/** Defines a reusable typed signal contract. */
export function defineWorkflowSignal<PayloadSchema extends ZodType>(
  options: WorkflowSignalOptions<PayloadSchema>,
): WorkflowSignal<PayloadSchema> {
  validateWorkflowName("signal", options.name);

  return {
    kind: "workflow-signal",
    name: options.name,
    validation: resolveValidation(options.validation),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    payloadSchema: options.payload,
  };
}

/** Validates stable lowercase names shared by workflow definitions. */
export function validateWorkflowName(
  kind: "signal" | "workflow",
  name: string,
): void {
  if (name.length === 0) {
    throw new TypeError(`Workflow ${kind} names cannot be empty.`);
  }

  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(name)) {
    throw new TypeError(
      `Workflow ${kind} names must contain lowercase segments separated by '.', '_' or '-'.`,
    );
  }
}
