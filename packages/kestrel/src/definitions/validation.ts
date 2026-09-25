import type { output, ZodSafeParseResult, ZodType } from "zod";

/** Selects schema parsing independently of the handler's execution model. */
export type ValidationMode = "sync" | "async";

/** Omitted boundaries use synchronous parsing. */
export interface ValidationOptions {
  readonly input?: ValidationMode;
  readonly output?: ValidationMode;
}

/** Input-only contracts cannot declare output validation. */
export type InputValidationOptions = Pick<ValidationOptions, "input">;

/** Normalized policy retained alongside the schemas on a definition. */
export interface DefinitionValidation {
  readonly input: ValidationMode;
  readonly output: ValidationMode;
}

/** Copies the policy so later edits to caller-owned options cannot change it. */
export function resolveValidation(
  options: ValidationOptions = {},
): DefinitionValidation {
  return Object.freeze({
    input: options.input ?? "sync",
    output: options.output ?? "sync",
  });
}

/**
 * Sync parsing can use an application-enabled Zod compiled fast path.
 * Never retry a failed parse: callbacks may already have performed work.
 */
export function parseSchema<Schema extends ZodType>(
  schema: Schema,
  value: unknown,
  mode: ValidationMode = "sync",
): output<Schema> | Promise<output<Schema>> {
  return mode === "async" ? schema.parseAsync(value) : schema.parse(value);
}

/** Preserves detailed validation issues without catching programming errors. */
export function safeParseSchema<Schema extends ZodType>(
  schema: Schema,
  value: unknown,
  mode: ValidationMode = "sync",
): ZodSafeParseResult<output<Schema>> | Promise<ZodSafeParseResult<output<Schema>>> {
  return mode === "async" ? schema.safeParseAsync(value) : schema.safeParse(value);
}
