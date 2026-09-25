import { BatchBuffer } from "../concurrency/index.js";
import type {
  JobReservationRef,
  WorkerAcknowledgementGrouping,
  WorkerAdapter,
} from "./types.js";

interface BufferedAcknowledgement {
  readonly queue: string;
  readonly reservation: JobReservationRef;
}

export interface WorkerAcknowledgementBufferOptions {
  maxSize: number;
  flushIntervalMs: number;
  grouping: WorkerAcknowledgementGrouping;
  /** Removes reservations from scheduler ownership after a durable ack. */
  onAcknowledged?: (jobs: readonly JobReservationRef[]) => void;
}

/**
 * Shares successful job acknowledgements across concurrent invocations.
 * Size and time boundaries limit latency while retaining backend batching.
 */
export class WorkerAcknowledgementBuffer {
  private readonly buffer: BatchBuffer<BufferedAcknowledgement>;

  public constructor(
    private readonly adapter: WorkerAdapter,
    private readonly options: WorkerAcknowledgementBufferOptions,
  ) {
    this.buffer = new BatchBuffer({
      maxBatchSize: options.maxSize,
      maxWaitMs: options.flushIntervalMs,
      execution: "sequential",
      handler: (batch) => this.flushBatch(batch),
    });
  }

  public get pendingCount(): number {
    return this.buffer.pendingCount;
  }

  /** Enqueues a success and starts a bounded background flush when needed. */
  public enqueue(queue: string, reservation: JobReservationRef): void {
    this.buffer.add({ queue, reservation });
  }

  /** Waits until every currently buffered or concurrently added ack settles. */
  public async flush(): Promise<void> {
    const result = await this.buffer.run();

    if (result.errors.length === 1) {
      throw result.errors[0]?.error;
    }

    if (result.errors.length > 1) {
      throw new AggregateError(
        result.errors.map(({ error }) => error),
        "Several worker acknowledgement batches failed.",
      );
    }
  }

  private async flushBatch(
    batch: readonly BufferedAcknowledgement[],
  ): Promise<void> {
    const groups = this.options.grouping === "queue"
      ? [...Map.groupBy(batch, (item) => item.queue).values()]
      : [batch];

    await Promise.all(groups.map(async (group) => {
      const reservations = group.map((item) => item.reservation);
      await this.adapter.ack(reservations);
      this.options.onAcknowledged?.(reservations);
    }));
  }
}
