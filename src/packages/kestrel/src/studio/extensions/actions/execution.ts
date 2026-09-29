import { ZodError } from "zod";

import type { ActionExecution } from "../../../app/index.js";
import {
  executionStartedObservation,
  executionCompletedObservation,
  getExecutionObservationContext,
  getExecutionObservationError,
  setExecutionLogContext,
} from "../../../app/observations.js";
import { defineActionMiddleware } from "../../../actions/index.js";
import type { HttpErrorRepresentation } from "../../../errors/index.js";
import {
  observerDependency,
  observerContextDependency,
} from "../../../observability/dependencies.js";
import type { AnyAction } from "../../../utils/definitions.js";
import type { StudioActionResult } from "./contract.js";

/** Preserve a failed scope outcome while exposing actionable Studio diagnostics. */
class StudioActionError extends Error {
  public constructor(
    private readonly result: Extract<
      StudioActionResult,
      { outcome: "failure" }
    >,
    private readonly statusCode: number,
    cause: unknown,
  ) {
    super(result.message, { cause });
  }

  public toHttpError(): HttpErrorRepresentation {
    return {
      statusCode: this.statusCode,
      message: this.message,
      extensions: this.result,
    };
  }
}

/** Run once in the HTTP-owned scope; Studio's polling requests remain unobserved. */
export async function executeStudioAction(
  execution: ActionExecution,
  action: AnyAction,
  input: unknown,
  observe: boolean,
): Promise<StudioActionResult> {
  const observation = observe
    ? execution.resolveDependencies({
        observer: observerDependency,
        context: observerContextDependency,
      })
    : undefined;
  const run = async (): Promise<StudioActionResult> => {
    const startedAt = performance.now();
    let enteredMiddleware = false;
    let failure: unknown;
    let outcome: "success" | "failure" = "success";
    const data = { operation: action.name, transport: "direct" as const };
    setExecutionLogContext(execution.context, data);
    observation?.observer.record(executionStartedObservation, data);
    try {
      // Mark the input boundary without parsing twice: transforms may have side effects.
      const boundary = defineActionMiddleware("studio.input-boundary", {
        handler: async (_context, next) => {
          enteredMiddleware = true;
          return next();
        },
      });
      const value = await execution
        .get({ ...action, middleware: [boundary, ...action.middleware] })
        .run(input);
      let result: Extract<StudioActionResult, { outcome: "success" }>["result"];
      try {
        // Use native JSON semantics, including enumerable properties and toJSON hooks.
        // Snapshot once so response serialization cannot invoke those hooks again.
        const serialized = JSON.stringify(value);
        result =
          serialized !== undefined
            ? { available: true, value: JSON.parse(serialized) }
            : {
                available: false,
                reason:
                  "The action succeeded, but its result has no JSON representation.",
              };
      } catch {
        result = {
          available: false,
          reason:
            "The action succeeded, but its result could not be serialized.",
        };
      }
      return {
        outcome: "success",
        executionId: execution.id,
        durationMs: performance.now() - startedAt,
        result,
      };
    } catch (error) {
      failure = error;
      outcome = "failure";
      const invalidInput = error instanceof ZodError && !enteredMiddleware;
      throw new StudioActionError(
        {
          outcome: "failure",
          executionId: execution.id,
          durationMs: performance.now() - startedAt,
          message:
            error instanceof ZodError
              ? invalidInput
                ? "The action input is invalid."
                : "Action validation failed during execution."
              : error instanceof Error
                ? error.message
                : String(error),
          ...(error instanceof ZodError
            ? {
                issues: error.issues.map((issue) => ({
                  path: issue.path.map((part) =>
                    typeof part === "symbol" ? String(part) : part,
                  ),
                  message: issue.message,
                })),
              }
            : {}),
        },
        invalidInput ? 400 : 500,
        error,
      );
    } finally {
      observation?.observer.record(
        executionCompletedObservation,
        {
          ...data,
          ...getExecutionObservationContext(execution.context),
          ...(outcome === "failure"
            ? getExecutionObservationError(failure)
            : {}),
        },
        { outcome, durationMs: performance.now() - startedAt },
      );
    }
  };
  return observation === undefined
    ? run()
    : observation.context.run(observation.observer, run);
}
