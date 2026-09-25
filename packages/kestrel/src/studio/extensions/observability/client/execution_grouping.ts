import type { StudioLog } from "../../logs/contract.js";
import type { StudioObservation } from "../contract.js";

export type ExecutionDisplayMode = "chronological" | "grouped";

export interface ExecutionArtifactGroup<Value> {
  executionId: string;
  items: readonly Value[];
}

export interface ExecutionGroupPresentation {
  title: string;
  details: readonly string[];
}

export interface CombinedExecutionGroup {
  executionId: string;
  logs: readonly StudioLog[];
  observations: readonly StudioObservation[];
}

/** Groups a chronological artifact stream without changing group or item order. */
export function groupExecutionArtifacts<Value>(
  items: readonly Value[],
  getExecutionId: (item: Value) => string | undefined,
): readonly ExecutionArtifactGroup<Value>[] {
  const grouped = new Map<string, Value[]>();

  for (const item of items) {
    const executionId = getExecutionId(item) ?? "unattributed";
    const group = grouped.get(executionId);

    if (group === undefined) {
      grouped.set(executionId, [item]);
    } else {
      group.push(item);
    }
  }

  return [...grouped].map(([executionId, groupItems]) => ({
    executionId,
    items: groupItems,
  }));
}

/** Derives a concise generic label from observation execution diagnostics. */
export function describeObservationExecution(
  items: readonly StudioObservation[],
): ExecutionGroupPresentation {
  return describeExecution(items.flatMap((item) => {
    const context = readRecord(item.data.context);
    return context === undefined ? [item.data] : [item.data, context];
  }));
}

/** Derives the same label from flattened structured-log diagnostics. */
export function describeLogExecution(
  items: readonly StudioLog[],
): ExecutionGroupPresentation {
  return describeExecution(items.flatMap((item) => {
    const context = readRecord(item.payload.executionContext);
    return context === undefined ? [item.payload] : [item.payload, context];
  }));
}

/** Reads the execution identity retained in every scoped structured log. */
export function getLogExecutionId(log: StudioLog): string | undefined {
  return readString(log.payload.executionId);
}

/** Joins two chronological artifact streams by execution discovery order. */
export function combineExecutionGroups(
  observations: readonly StudioObservation[],
  logs: readonly StudioLog[],
): readonly CombinedExecutionGroup[] {
  const observationGroups = groupExecutionArtifacts(
    observations,
    (item) => item.executionId,
  );
  const logGroups = groupExecutionArtifacts(logs, getLogExecutionId);
  const logsByExecution = new Map(
    logGroups.map((group) => [group.executionId, group.items]),
  );
  const groups: CombinedExecutionGroup[] = observationGroups.map((group) => ({
    executionId: group.executionId,
    observations: group.items,
    logs: logsByExecution.get(group.executionId) ?? [],
  }));
  const observedExecutionIds = new Set(
    observationGroups.map((group) => group.executionId),
  );

  for (const group of logGroups) {
    if (!observedExecutionIds.has(group.executionId)) {
      groups.push({
        executionId: group.executionId,
        observations: [],
        logs: group.items,
      });
    }
  }

  return groups;
}

function describeExecution(
  sources: readonly Record<string, unknown>[],
): ExecutionGroupPresentation {
  const values = Object.assign({}, ...sources);
  const taskKind = readString(values["workflow.taskKind"]);
  const activityTarget = readString(values["workflow.activityTarget"]);
  const operation = readString(values.operation);
  const transport = readString(values.transport);
  const title = taskKind === "activity"
    ? activityTarget === undefined ? "Activity" : `Activity · ${activityTarget}`
    : taskKind === "timer"
      ? "Timer"
      : taskKind === "workflow"
        ? "Workflow task"
        : operation === undefined
          ? "Application execution"
          : transport === undefined
            ? operation
            : `${formatLabel(transport)} · ${operation}`;
  const details = [
    formatDetail("Attempt", values["workflow.taskAttempt"]),
    formatDetail("Command", values["workflow.commandSequence"]),
    formatDetail("Task", values["workflow.taskId"]),
  ].filter((detail): detail is string => detail !== undefined);

  return { title, details };
}

function formatDetail(label: string, value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? `${label} ${value}`
    : undefined;
}

function formatLabel(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
