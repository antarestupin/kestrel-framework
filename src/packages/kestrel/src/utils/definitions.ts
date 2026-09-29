import type { Action } from "../actions/index.js";
import type { CliController } from "../cli/index.js";
import type { HttpController } from "../http/index.js";
import type { AnyScheduledTask } from "../scheduled_tasks/index.js";
import type { AnyWorker } from "../workers/index.js";
import type { AnyWorkflow } from "../workflows/index.js";

/** An action whose concrete schemas and dependencies are intentionally erased. */
export type AnyAction = Action<any, any, any>;

/** An HTTP controller prepared for heterogeneous catalog registration. */
export type AnyHttpController = HttpController<
  any,
  any,
  any,
  any,
  any,
  any
>;

/** A CLI controller prepared for heterogeneous catalog registration. */
export type AnyCliController = CliController<
  any,
  any,
  any,
  any,
  any,
  any
>;

export type { AnyWorker };
export type { AnyScheduledTask };
export type { AnyWorkflow };

/** Identifies an action terminal value inside a nested catalog. */
export function isAction(value: unknown): value is AnyAction {
  return (
    isObject(value)
    && value.kind !== "workflow"
    && "name" in value
    && "inputSchema" in value
    && "outputSchema" in value
    && "handler" in value
  );
}

/** Identifies a durable workflow terminal value inside a nested catalog. */
export function isWorkflow(value: unknown): value is AnyWorkflow {
  return (
    isObject(value)
    && value.kind === "workflow"
    && "name" in value
    && "version" in value
    && "inputSchema" in value
    && "signals" in value
    && "handler" in value
  );
}

/** Identifies an HTTP controller terminal value inside a nested catalog. */
export function isHttpController(
  value: unknown,
): value is AnyHttpController {
  return (
    isObject(value)
    && "source" in value
    && "route" in value
  );
}

/** Identifies a CLI controller terminal value inside a nested catalog. */
export function isCliController(
  value: unknown,
): value is AnyCliController {
  return (
    isObject(value)
    && "source" in value
    && "command" in value
  );
}

/** Identifies a worker terminal value inside a nested catalog. */
export function isWorker(value: unknown): value is AnyWorker {
  return (
    isObject(value)
    && "name" in value
    && "queue" in value
    && "inputSchema" in value
    && "handler" in value
  );
}

/** Identifies a scheduled-task terminal value inside a nested catalog. */
export function isScheduledTask(value: unknown): value is AnyScheduledTask {
  return (
    isObject(value)
    && "id" in value
    && "schedule" in value
    && "overlap" in value
    && "handler" in value
  );
}

/** Narrows an unknown value to a non-null object with string keys. */
export function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
