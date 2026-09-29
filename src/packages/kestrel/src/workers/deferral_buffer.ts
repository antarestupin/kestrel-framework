import { BatchBuffer } from "../concurrency/index.js";
import type {
  DeferJobRequest,
  JobReservationRef,
  WorkerAdapter,
} from "./types.js";

interface BufferedDeferral {
  request: DeferJobRequest;
  onPersisted: () => void;
}

export interface WorkerDeferralBufferOptions {
  maxSize: number;
  flushIntervalMs: number;
  /** Removes only reservations confirmed by the adapter from local ownership. */
  onDeferred: (jobs: readonly JobReservationRef[]) => void;
}

/** Coalesces rejected invocations while their leases remain protected. */
export class WorkerDeferralBuffer {
  private readonly buffer: BatchBuffer<BufferedDeferral>;

  public constructor(
    adapter: WorkerAdapter,
    options: WorkerDeferralBufferOptions,
  ) {
    this.buffer = new BatchBuffer({
      maxBatchSize: options.maxSize,
      maxWaitMs: options.flushIntervalMs,
      execution: "sequential",
      handler: async (batch) => {
        const deferred = await adapter.defer(batch.map(({ request }) => request));
        options.onDeferred(deferred);
        for (const item of batch) item.onPersisted();
      },
    });
  }

  /** Records an invocation decision only after all its chunks reach storage. */
  public enqueue(
    requests: readonly DeferJobRequest[],
    onPersisted: () => void,
  ): void {
    let remaining = requests.length;
    for (const request of requests) {
      this.buffer.add({
        request,
        onPersisted: () => {
          remaining -= 1;
          if (remaining === 0) onPersisted();
        },
      });
    }
  }

  /** Storage failures leave jobs leased for redelivery, without worker retries. */
  public async flush(): Promise<void> {
    const { errors } = await this.buffer.run();
    if (errors.length === 1) throw errors[0]!.error;
    if (errors.length > 1) {
      throw new AggregateError(
        errors.map(({ error }) => error),
        "Several worker deferral batches failed.",
      );
    }
  }
}
