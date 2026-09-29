import {
  AggregatedResultBuilder,
  BatchBuffer,
  type AggregatedResult,
} from "../concurrency/index.js";

import type {
  CompleteWorkflowActivityRequest,
  WorkflowAdapter,
} from "./adapter.js";

export interface WorkflowCompletionBufferOptions {
  maxSize: number;
  flushIntervalMs: number;
}

/** Batches activity and timer journal transitions behind per-task promises. */
export class WorkflowCompletionBuffer {
  private readonly buffer: BatchBuffer<
    CompleteWorkflowActivityRequest,
    AggregatedResult<
      CompleteWorkflowActivityRequest,
      boolean,
      never
    >
  >;

  public constructor(
    private readonly adapter: WorkflowAdapter,
    options: WorkflowCompletionBufferOptions,
  ) {
    this.buffer = new BatchBuffer({
      maxBatchSize: options.maxSize,
      maxWaitMs: options.flushIntervalMs,
      // Sequential flushes preserve buffer arrival order across ready batches.
      execution: "sequential",
      handler: (batch) => this.flushBatch(batch),
    });
  }

  /** Waits until the request is durably committed or found stale. */
  public enqueue(request: CompleteWorkflowActivityRequest): Promise<boolean> {
    return this.buffer.addAndWait(request);
  }

  /** Forces every pending completion through the adapter. */
  public async flush(): Promise<void> {
    const result = await this.buffer.run();
    if (result.errors.length === 0) return;

    throw result.errors.length === 1
      ? result.errors[0]!.error
      : new AggregateError(
          result.errors.map(({ error }) => error),
          "Several workflow completion batches failed.",
        );
  }

  private async flushBatch(
    batch: readonly CompleteWorkflowActivityRequest[],
  ) {
    const committed = await this.adapter.completeActivities(batch);
    const committedKeys = new Set(committed.map(toReservationKey));
    const result = new AggregatedResultBuilder<
      CompleteWorkflowActivityRequest,
      boolean,
      never
    >();

    for (const request of batch) {
      result.addResult(request, committedKeys.has(toReservationKey(request)));
    }

    return result.build();
  }
}

function toReservationKey(
  reservation: { taskId: string; reservationToken: string },
): string {
  return `${reservation.taskId}:${reservation.reservationToken}`;
}
