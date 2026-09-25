import {
  type input,
  type output,
  type ZodType,
} from "zod";

import { type ValidationMode, parseSchema } from "../definitions/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import {
  defineAction,
  type Action,
} from "./action.js";

/**
 * Creates an action derivation that replaces the public input contract and
 * maps it back to the source action input.
 *
 * The source schema parses the mapped value before its handler runs, retaining
 * refinements and transformations declared at the original action boundary.
 * The optional mode applies only to the replacement schema, defaulting to sync.
 */
export function mapActionInput<
  DerivedInputSchema extends ZodType,
  MappedInput,
>(
  inputSchema: DerivedInputSchema,
  mapInput: (
    input: output<DerivedInputSchema>,
  ) => MappedInput | Promise<MappedInput>,
  validation: ValidationMode = "sync",
) {
  return <
    SourceInputSchema extends ZodType,
    OutputSchema extends ZodType,
    const Dependencies extends DependencyDeclarations<never>,
  >(
    action:
      Action<
        SourceInputSchema,
        OutputSchema,
        Dependencies
      >
      & (
        Awaited<MappedInput> extends input<SourceInputSchema>
          ? unknown
          : never
      ),
  ): Action<
    DerivedInputSchema,
    OutputSchema,
    Dependencies
  > =>
    defineAction({
      name: action.name,
      input: inputSchema,
      output: action.outputSchema,
      // Only the replaced boundary receives a new policy.
      validation: { input: validation, output: action.validation.output },
      ...(action.description === undefined
        ? {}
        : { description: action.description }),
      dependencies: action.dependencies,
      middleware: action.middleware,
      handler: async (input, dependencies) => {
        const mappedInput = await mapInput(input);
        const parsedInput =
          await parseSchema(action.inputSchema, mappedInput, action.validation.input);

        return action.handler(
          parsedInput as output<SourceInputSchema>,
          dependencies,
        ) as
          | input<OutputSchema>
          | Promise<input<OutputSchema>>;
      },
    });
}
