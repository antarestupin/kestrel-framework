import { WorkerPublicationBudgetError } from "./errors.js";
import { serializeWorkerPayload } from "./serialization.js";
import type { EnqueueJobRequest, WorkerJobCorrelation, WorkerPublicationBudgets } from "./types.js";
export type { WorkerPublicationBudgets } from "./types.js";

/** Validates and detaches configuration so later caller mutations cannot change policy. */
export function resolveWorkerPublicationBudgets(
  budgets: WorkerPublicationBudgets,
): WorkerPublicationBudgets {
  const resolved = {
    maxJobBytes: budgets.maxJobBytes,
    maxBatchBytes: budgets.maxBatchBytes,
    maxBatchSize: budgets.maxBatchSize,
  };
  for (const name of ["maxJobBytes", "maxBatchBytes", "maxBatchSize"] as const) {
    const value = resolved[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError(`Worker publication ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(resolved);
}

/** Per-publication accounting, used only before writing to the backend. */
export class WorkerPublicationBudgetGuard {
  private batchBytes = 0;
  private jobIndex = 0;

  public constructor(private readonly budgets: WorkerPublicationBudgets, count: number) {
    this.check("maxBatchSize", count);
  }

  /** Count the serialized UTF-8 data, not JavaScript string length or transport framing. */
  public snapshot(request: EnqueueJobRequest): EnqueueJobRequest {
    const payload = serializeWorkerPayload(request.payload);
    const correlation = request.correlation === undefined
      ? undefined
      : serializeWorkerPayload(request.correlation);
    const jobBytes = payload.bytes + (correlation?.bytes ?? 0);
    this.check("maxJobBytes", jobBytes, this.jobIndex);
    this.batchBytes += jobBytes;
    this.check("maxBatchBytes", this.batchBytes, this.jobIndex);
    this.jobIndex++;

    return {
      ...request,
      payload: payload.value,
      ...(correlation === undefined ? {} : {
        correlation: correlation.value as WorkerJobCorrelation,
      }),
      ...(request.availableAt === undefined ? {} : {
        availableAt: new Date(request.availableAt.getTime()),
      }),
    };
  }

  private check(budget: keyof WorkerPublicationBudgets, actual: number, jobIndex?: number): void {
    const limit = this.budgets[budget];
    if (limit !== undefined && actual > limit) {
      throw new WorkerPublicationBudgetError(budget, limit, actual, jobIndex);
    }
  }
}

/** Prepare the complete batch before direct adapter calls can perform any writes. */
export function snapshotWorkerRequests(
  requests: readonly EnqueueJobRequest[],
  budgets: WorkerPublicationBudgets,
): readonly EnqueueJobRequest[] {
  const guard = new WorkerPublicationBudgetGuard(budgets, requests.length);
  return requests.map((request) => guard.snapshot(request));
}
