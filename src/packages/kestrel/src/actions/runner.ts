import {
  type input,
  type output,
  type ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import {
  type DependencyContainer,
  type DependencyDeclarations,
} from "../di/index.js";
import { runMiddlewarePipeline } from "../middleware/index.js";
import type { Action } from "./action.js";

export interface ActionRunner<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
> {
  run(input: input<InputSchema>): Promise<output<OutputSchema>>;
}

/**
 * Binds an action definition to an application's dependency container.
 */
export function createActionRunner<
  Config,
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<Config>,
>(
  container: DependencyContainer<Config>,
  action: Action<
    InputSchema,
    OutputSchema,
    Dependencies
  >,
): ActionRunner<InputSchema, OutputSchema> {
  return {
    async run(
      rawInput: input<InputSchema>,
    ): Promise<output<OutputSchema>> {
      // Apply the declared parsing policy before middleware sees the input.
      const parsedInput =
        await parseSchema(action.inputSchema, rawInput, action.validation.input);
      const execute = async (): Promise<output<OutputSchema>> => {
        const dependencies = container.resolveDependencies(
          action.dependencies,
        );
        const rawOutput = await action.handler(
          parsedInput,
          dependencies,
        );

        return await parseSchema(
          action.outputSchema,
          rawOutput,
          action.validation.output,
        );
      };

      return runMiddlewarePipeline(
        action.middleware,
        { action, input: parsedInput },
        container,
        execute,
      );
    },
  };
}
