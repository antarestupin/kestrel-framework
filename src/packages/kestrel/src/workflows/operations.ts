import { createUuid } from "../utils/uuid.js";
import { parseSchema } from "../definitions/index.js";

import type {
  WorkflowAdapter,
  WorkflowExecution,
  WorkflowExecutionPage,
  WorkflowExecutionQuery,
  WorkflowExecutionVersionSummary,
  WorkflowHistoryArchive,
  WorkflowSignalReceipt,
} from "./adapter.js";
import { isTerminalWorkflowStatus } from "./adapter.js";
import { WorkflowExecutionNotFoundError } from "./errors.js";
import type {
  WorkflowCommandCompletedEvent,
  WorkflowCommandScheduledEvent,
  WorkflowHistoryEvent,
} from "./history.js";
import {
  jsonWorkflowPayloadCodec,
  type WorkflowPayloadCodec,
} from "./serialization.js";
import { WorkflowVersionOperations } from "./version_operations.js";
import type { WorkflowVersionInventory } from "./version_operations.js";
import type { AnyWorkflow } from "./workflow.js";
import type { WorkflowInstrumentation } from "./observations.js";

export interface WorkflowOperationsOptions {
  createExecutionId?: () => string;
  payloadCodec?: WorkflowPayloadCodec;
  instrumentation?: WorkflowInstrumentation;
}

export interface WorkflowDefinitionOperationsSummary {
  name: string;
  description?: string;
  currentVersion: number;
  supportedFrom: number;
  signals: readonly string[];
  executions: readonly WorkflowExecutionVersionSummary[];
}

export interface WorkflowExecutionDetails {
  execution: WorkflowExecution;
  history: readonly WorkflowHistoryEvent[];
  archives: readonly WorkflowHistoryArchive[];
  children: readonly WorkflowExecution[];
  retries: readonly WorkflowExecution[];
  waits: readonly WorkflowExecutionWait[];
  graph: WorkflowExecutionGraph;
}

export interface WorkflowExecutionWait {
  sequence: number;
  kind: string;
  target: string;
  scheduledAt: Date;
  deadline?: Date;
}

export interface WorkflowExecutionGraphNode {
  id: string;
  kind: "command" | "execution" | "signal";
  label: string;
  status: "completed" | "failed" | "pending" | WorkflowExecution["status"];
  occurredAt?: Date;
  completedAt?: Date;
  executionId?: string;
  sequence?: number;
}

export interface WorkflowExecutionGraphEdge {
  from: string;
  to: string;
  kind: "child" | "command" | "signal";
}

/** Exact path followed by one execution, derived only from durable history. */
export interface WorkflowExecutionGraph {
  nodes: readonly WorkflowExecutionGraphNode[];
  edges: readonly WorkflowExecutionGraphEdge[];
}

export interface SendOperationalWorkflowSignalRequest {
  executionId: string;
  signalName: string;
  payload: unknown;
  idempotencyKey?: string;
}

/** Storage-neutral read and control surface intended for protected operator APIs. */
export class WorkflowOperations {
  private readonly definitions: ReadonlyMap<string, AnyWorkflow>;
  private readonly versions: WorkflowVersionOperations;
  private readonly createExecutionId: () => string;
  private readonly payloadCodec: WorkflowPayloadCodec;
  private readonly instrumentation: WorkflowInstrumentation | undefined;

  public constructor(
    definitions: readonly AnyWorkflow[],
    private readonly adapter: WorkflowAdapter,
    options: WorkflowOperationsOptions = {},
  ) {
    this.definitions = new Map(definitions.map((definition) => [
      definition.name,
      definition,
    ]));
    this.versions = new WorkflowVersionOperations(definitions, adapter);
    this.createExecutionId = options.createExecutionId ?? createUuid;
    this.payloadCodec = options.payloadCodec ?? jsonWorkflowPayloadCodec;
    this.instrumentation = options.instrumentation;
  }

  public async listDefinitions(): Promise<
    readonly WorkflowDefinitionOperationsSummary[]
  > {
    const summaries = await this.adapter.summarizeExecutionVersions();
    return [...this.definitions.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition) => ({
        name: definition.name,
        ...(definition.description === undefined
          ? {}
          : { description: definition.description }),
        currentVersion: definition.version.current,
        supportedFrom: definition.version.supportedFrom,
        signals: definition.signals.map(({ name }) => name),
        executions: summaries.filter(({ workflowName }) =>
          workflowName === definition.name),
      }));
  }

  public inspectVersions(): Promise<WorkflowVersionInventory> {
    return this.versions.inspect();
  }

  public listExecutions(query: WorkflowExecutionQuery): Promise<WorkflowExecutionPage> {
    return this.adapter.listExecutions(query);
  }

  public async getExecution(executionId: string): Promise<WorkflowExecutionDetails> {
    const execution = await this.requireExecution(executionId);
    const [history, archives, children, retries] = await Promise.all([
      this.adapter.getHistory(executionId),
      this.adapter.getHistoryArchives(executionId),
      this.adapter.listExecutions({ limit: 200, parentExecutionId: executionId }),
      this.adapter.listExecutions({ limit: 200, retryOfExecutionId: executionId }),
    ]);
    return {
      execution,
      history,
      archives,
      children: children.items,
      retries: retries.items,
      waits: getWorkflowExecutionWaits(history, execution.status),
      graph: buildWorkflowExecutionGraph(execution, history, children.items),
    };
  }

  public async signal(
    request: SendOperationalWorkflowSignalRequest,
  ): Promise<WorkflowSignalReceipt> {
    const execution = await this.requireExecution(request.executionId);
    const definition = this.requireDefinition(execution.workflowName);
    const signal = definition.signals.find(({ name }) =>
      name === request.signalName);
    if (signal === undefined) {
      throw new TypeError(
        `Signal "${request.signalName}" is not declared by workflow "${definition.name}".`,
      );
    }
    const parsed = await parseSchema(
      signal.payloadSchema,
      request.payload,
      signal.validation.input,
    );
    const payload = await this.payloadCodec.encode(parsed);
    return this.adapter.sendSignal({
      executionId: request.executionId,
      workflowName: definition.name,
      signalName: signal.name,
      payload,
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }),
    });
  }

  public pause(executionId: string): Promise<boolean> {
    return this.adapter.setPaused(executionId, true);
  }

  public resume(executionId: string): Promise<boolean> {
    return this.adapter.setPaused(executionId, false);
  }

  public cancel(executionId: string): Promise<boolean> {
    return this.adapter.requestCancellation(executionId);
  }

  public terminate(executionId: string, reason?: string): Promise<boolean> {
    return this.adapter.forceTerminate(executionId, reason);
  }

  public recover(executionId: string): Promise<boolean> {
    return this.versions.recover(executionId);
  }

  public async retry(
    executionId: string,
    newExecutionId = this.createExecutionId(),
  ): Promise<WorkflowExecution> {
    const execution = await this.requireExecution(executionId);
    const definition = this.requireDefinition(execution.workflowName);
    const result = await this.adapter.retryExecution({
      sourceExecutionId: executionId,
      executionId: newExecutionId,
      workflowVersion: definition.version.current,
    });
    try {
      if (result.created) this.instrumentation?.record({
        type: "lifecycle",
        outcome: "success",
        data: {
          executionId: result.execution.executionId,
          workflowName: result.execution.workflowName,
          workflowVersion: result.execution.workflowVersion,
          historyGeneration: result.execution.historyGeneration,
          operation: "retry",
          status: result.execution.status,
          sourceExecutionId: executionId,
        },
      });
    } catch {
      // Operator observability cannot change the already durable retry.
    }
    return result.execution;
  }

  private async requireExecution(executionId: string): Promise<WorkflowExecution> {
    const execution = await this.adapter.get(executionId);
    if (execution === undefined) throw new WorkflowExecutionNotFoundError(executionId);
    return execution;
  }

  private requireDefinition(workflowName: string): AnyWorkflow {
    const definition = this.definitions.get(workflowName);
    if (definition === undefined) {
      throw new TypeError(`Workflow definition "${workflowName}" is not deployed.`);
    }
    return definition;
  }
}

export function getWorkflowExecutionWaits(
  history: readonly WorkflowHistoryEvent[],
  executionStatus?: WorkflowExecution["status"],
): readonly WorkflowExecutionWait[] {
  // Terminal executions cannot have active waits, even though their immutable
  // history may still contain commands that were interrupted before completion.
  if (executionStatus !== undefined && isTerminalWorkflowStatus(executionStatus)) {
    return [];
  }
  const cancellationEventIndex = getCancellationEventIndex(history);
  const completed = new Set(history
    .filter((event) => event.type === "command-completed")
    .map((event) => event.sequence));
  return history
    .filter((event): event is WorkflowCommandScheduledEvent =>
      event.type === "command-scheduled"
      && !completed.has(event.sequence)
      && (
        cancellationEventIndex === undefined
        || event.eventIndex > cancellationEventIndex
      ))
    .map((event) => {
      const delayMs = readWaitDelay(event);
      return {
        sequence: event.sequence,
        kind: event.kind,
        target: event.target,
        scheduledAt: event.occurredAt,
        ...(delayMs === undefined
          ? {}
          : { deadline: new Date(event.occurredAt.getTime() + delayMs) }),
      };
    });
}

function readWaitDelay(event: WorkflowCommandScheduledEvent): number | undefined {
  if (event.payload === null || Array.isArray(event.payload)
    || typeof event.payload !== "object") return undefined;
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const direct = event.kind === "timer"
    ? payload.durationMs
    : event.kind === "signal"
      ? payload.timeoutMs
      : undefined;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (event.kind !== "activity" || payload.options === null
    || Array.isArray(payload.options) || typeof payload.options !== "object") {
    return undefined;
  }
  const timeout = (payload.options as Readonly<Record<string, unknown>>)
    .scheduleToCloseTimeoutMs;
  return typeof timeout === "number" && Number.isFinite(timeout)
    ? timeout
    : undefined;
}

export function buildWorkflowExecutionGraph(
  execution: WorkflowExecution,
  history: readonly WorkflowHistoryEvent[],
  children: readonly WorkflowExecution[] = [],
): WorkflowExecutionGraph {
  const rootId = `execution:${execution.executionId}`;
  const nodes: WorkflowExecutionGraphNode[] = [{
    id: rootId,
    kind: "execution",
    label: `${execution.workflowName}@${execution.workflowVersion}`,
    status: execution.status,
    occurredAt: execution.createdAt,
    ...(execution.completedAt === undefined
      ? {}
      : { completedAt: execution.completedAt }),
    executionId: execution.executionId,
  }];
  const edges: WorkflowExecutionGraphEdge[] = [];
  const completions = new Map(history
    .filter((event): event is WorkflowCommandCompletedEvent =>
      event.type === "command-completed")
    .map((event) => [event.sequence, event]));
  const cancellationEventIndex = getCancellationEventIndex(history);

  for (const event of history) {
    if (event.type === "command-scheduled") {
      appendCommandNode(
        nodes,
        edges,
        rootId,
        event,
        completions.get(event.sequence),
        cancellationEventIndex !== undefined
          && event.eventIndex < cancellationEventIndex
          ? "cancelled"
          : execution.status === "terminated"
            ? "terminated"
            : undefined,
      );
    } else if (event.type === "signal-received") {
      const id = `signal:${event.signalId}`;
      nodes.push({
        id,
        kind: "signal",
        label: event.name,
        status: "completed",
        occurredAt: event.occurredAt,
      });
      edges.push({ from: id, to: rootId, kind: "signal" });
    }
  }

  for (const child of children) {
    const id = `execution:${child.executionId}`;
    nodes.push({
      id,
      kind: "execution",
      label: `${child.workflowName}@${child.workflowVersion}`,
      status: child.status,
      occurredAt: child.createdAt,
      ...(child.completedAt === undefined ? {} : { completedAt: child.completedAt }),
      executionId: child.executionId,
    });
    edges.push({
      from: child.parentCommandSequence === undefined
        ? rootId
        : `command:${child.parentCommandSequence}`,
      to: id,
      kind: "child",
    });
  }
  return { nodes, edges };
}

function appendCommandNode(
  nodes: WorkflowExecutionGraphNode[],
  edges: WorkflowExecutionGraphEdge[],
  rootId: string,
  scheduled: WorkflowCommandScheduledEvent,
  completion: WorkflowCommandCompletedEvent | undefined,
  interruptedStatus: "cancelled" | "terminated" | undefined,
): void {
  const id = `command:${scheduled.sequence}`;
  nodes.push({
    id,
    kind: "command",
    label: `${scheduled.kind}: ${scheduled.target}`,
    status: completion === undefined
      ? interruptedStatus ?? "pending"
      : completion.error === undefined ? "completed" : "failed",
    occurredAt: scheduled.occurredAt,
    ...(completion === undefined ? {} : { completedAt: completion.occurredAt }),
    sequence: scheduled.sequence,
  });
  edges.push({ from: rootId, to: id, kind: "command" });
}

function getCancellationEventIndex(
  history: readonly WorkflowHistoryEvent[],
): number | undefined {
  return history.find((event) => event.type === "cancellation-requested")
    ?.eventIndex;
}
