import type {
  WorkflowAdapter,
  WorkflowExecutionStatus,
  WorkflowExecutionVersionSummary,
} from "./adapter.js";
import {
  WorkflowDeploymentVersionError,
  WorkflowExecutionNotFoundError,
  WorkflowExecutionVersionUnsupportedError,
} from "./errors.js";
import type { AnyWorkflow } from "./workflow.js";

export interface WorkflowVersionDiagnostic {
  workflowName: string;
  workflowVersion: number;
  count: number;
  statuses: Partial<Record<WorkflowExecutionStatus, number>>;
  reason: "definition-missing" | "version-unsupported";
}

export interface WorkflowVersionInventory {
  summaries: readonly WorkflowExecutionVersionSummary[];
  unsupportedActiveVersions: readonly WorkflowVersionDiagnostic[];
}

/** Read-only deployment checks plus narrow recovery for version-blocked runs. */
export class WorkflowVersionOperations {
  private readonly definitions: ReadonlyMap<string, AnyWorkflow>;

  public constructor(
    definitions: readonly AnyWorkflow[],
    private readonly adapter: WorkflowAdapter,
  ) {
    this.definitions = new Map(definitions.map((definition) => [
      definition.name,
      definition,
    ]));
  }

  public async inspect(): Promise<WorkflowVersionInventory> {
    const summaries = await this.adapter.summarizeExecutionVersions();
    const grouped = new Map<string, WorkflowVersionDiagnostic>();

    for (const summary of summaries) {
      if (isTerminal(summary.status)) continue;
      const definition = this.definitions.get(summary.workflowName);
      const reason = definition === undefined
        ? "definition-missing" as const
        : summary.workflowVersion < definition.version.supportedFrom
            || summary.workflowVersion > definition.version.current
          ? "version-unsupported" as const
          : undefined;
      if (reason === undefined) continue;

      const key = `${summary.workflowName}\u0000${summary.workflowVersion}`;
      const diagnostic = grouped.get(key) ?? {
        workflowName: summary.workflowName,
        workflowVersion: summary.workflowVersion,
        count: 0,
        statuses: {},
        reason,
      };
      diagnostic.count += summary.count;
      diagnostic.statuses[summary.status] =
        (diagnostic.statuses[summary.status] ?? 0) + summary.count;
      grouped.set(key, diagnostic);
    }

    return {
      summaries,
      unsupportedActiveVersions: [...grouped.values()].sort((left, right) =>
        left.workflowName.localeCompare(right.workflowName)
        || left.workflowVersion - right.workflowVersion),
    };
  }

  public async assertCompatible(): Promise<WorkflowVersionInventory> {
    const inventory = await this.inspect();
    if (inventory.unsupportedActiveVersions.length > 0) {
      throw new WorkflowDeploymentVersionError(
        inventory.unsupportedActiveVersions.map((diagnostic) => ({
          workflowName: diagnostic.workflowName,
          workflowVersion: diagnostic.workflowVersion,
          count: diagnostic.count,
          reason: diagnostic.reason,
        })),
      );
    }
    return inventory;
  }

  public async recover(executionId: string): Promise<boolean> {
    const execution = await this.adapter.get(executionId);
    if (execution === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }
    const definition = this.definitions.get(execution.workflowName);
    if (
      definition === undefined
      || execution.workflowVersion < definition.version.supportedFrom
      || execution.workflowVersion > definition.version.current
    ) {
      throw new WorkflowExecutionVersionUnsupportedError(
        executionId,
        execution.workflowVersion,
        definition?.version.supportedFrom ?? 0,
        definition?.version.current ?? 0,
      );
    }
    return this.adapter.recoverVersionBlockedExecution({
      executionId,
      workflowName: execution.workflowName,
      workflowVersion: execution.workflowVersion,
    });
  }
}

function isTerminal(status: WorkflowExecutionStatus): boolean {
  return status === "cancelled"
    || status === "completed"
    || status === "failed"
    || status === "terminated";
}
