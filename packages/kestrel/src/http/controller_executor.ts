import type { FastifyReply, FastifyRequest } from "fastify";
import type { input, output, ZodType } from "zod";

import { parseSchema } from "../definitions/index.js";
import type { ActionExecution } from "../app/index.js";
import type {
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import { runMiddlewarePipeline } from "../middleware/index.js";
import type { HttpController, HttpObjectSchema } from "./controller.js";

export interface HttpControllerExecutionContext {
  readonly execution: ActionExecution;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

/**
 * Executes an already validated HTTP controller input inside an existing scope.
 * Route binding, response serialization and error rendering stay with the caller.
 */
export function executeHttpController<
  ActionInputSchema extends HttpObjectSchema,
  ActionOutputSchema extends ZodType,
  ActionDependencies extends DependencyDeclarations<never>,
  ControllerInputSchema extends HttpObjectSchema,
  ControllerOutputSchema extends ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never>,
>(
  controller: HttpController<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies,
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  >,
  parsedInput: output<ControllerInputSchema>,
  context: HttpControllerExecutionContext,
): Promise<unknown> {
  return runMiddlewarePipeline(
    [
      // Access middleware cannot be displaced by controller-local concerns.
      ...controller.access.middleware,
      ...controller.middleware,
    ],
    {
      controller,
      input: parsedInput,
      request: context.request,
      reply: context.reply,
      execution: context.execution,
    },
    context.execution,
    async () => {
      const dependencies = context.execution.resolveDependencies(
        controller.dependencies,
      );
      const result = controller.source === "standalone"
        ? await controller.handler({
            input: parsedInput,
            deps: dependencies,
            request: context.request,
            reply: context.reply,
            execution: context.execution,
          })
        : await executeActionController(
            controller,
            parsedInput,
            dependencies,
            context,
          );

      return controller.outputSchema === undefined
        || context.reply.sent
        || usesValidatedActionOutput(controller)
        ? result
        : parseSchema(controller.outputSchema, result, controller.validation.output);
    },
  );
}

/** Executes an action-backed controller with its optional HTTP adapter. */
async function executeActionController<
  ActionInputSchema extends HttpObjectSchema,
  ActionOutputSchema extends ZodType,
  ActionDependencies extends DependencyDeclarations<never>,
  ControllerInputSchema extends HttpObjectSchema,
  ControllerOutputSchema extends ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never>,
>(
  controller: Extract<
    HttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
    { source: "action" }
  >,
  parsedInput: output<ControllerInputSchema>,
  dependencies: ResolvedDependencies<ControllerDependencies>,
  context: HttpControllerExecutionContext,
): Promise<unknown> {
  const action = context.execution.get(controller.action);

  return controller.handler === undefined
    ? await action.run(parsedInput as input<ActionInputSchema>)
    : await controller.handler({
        action,
        input: parsedInput,
        deps: dependencies,
        request: context.request,
        reply: context.reply,
        execution: context.execution,
      });
}

/** Avoids applying an inherited Action output transform twice. */
function usesValidatedActionOutput(
  controller: HttpController<any, any, any, any, any, any>,
): boolean {
  return controller.source === "action"
    && controller.handler === undefined
    && controller.outputSchema === controller.action.outputSchema;
}
