import {
  type input,
  type ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import type {
  EnqueueJobRequest,
  WorkerAdapter,
  WorkerJobCorrelation,
} from "./types.js";
import type { Worker } from "./worker.js";

export interface WorkerEnqueueOptions {
  /** Stable identity used by adapters to deduplicate publication retries. */
  identity?: string;
  /** Routes the eventual terminal result without coupling queue adapters. */
  correlation?: WorkerJobCorrelation;
  availableAt?: Date;
  groupId?: string;
  /** Requests an execution id for the job's first processing attempt. */
  executionId?: string;
}

/** Typed application API for publishing jobs to worker queues. */
export class WorkerClient {
  public constructor(private readonly adapter: WorkerAdapter) {}

  public async enqueue<
    InputSchema extends ZodType,
    Dependencies extends DependencyDeclarations<never>,
  >(
    worker: Worker<InputSchema, Dependencies>,
    rawPayload: input<InputSchema>,
    options: WorkerEnqueueOptions = {},
  ): Promise<string> {
    const jobIds = await this.enqueueRequests(
      worker,
      [rawPayload],
      options,
    );
    const jobId = jobIds[0];

    if (jobId === undefined) {
      throw new Error("The worker adapter did not return the enqueued job ID.");
    }

    return jobId;
  }

  /** Validates and publishes multiple jobs through one adapter operation. */
  public enqueueMany<
    InputSchema extends ZodType,
    Dependencies extends DependencyDeclarations<never>,
  >(
    worker: Worker<InputSchema, Dependencies>,
    rawPayloads: readonly input<InputSchema>[],
    options: WorkerEnqueueOptions = {},
  ): Promise<readonly string[]> {
    return this.enqueueRequests(worker, rawPayloads, options);
  }

  private async enqueueRequests<
    InputSchema extends ZodType,
    Dependencies extends DependencyDeclarations<never>,
  >(
    worker: Worker<InputSchema, Dependencies>,
    rawPayloads: readonly input<InputSchema>[],
    options: WorkerEnqueueOptions,
  ): Promise<readonly string[]> {
    if (options.identity !== undefined && rawPayloads.length > 1) {
      throw new TypeError(
        "A stable Worker identity can only describe one enqueued job.",
      );
    }

    // Validate the complete batch before writing anything to the adapter.
    const payloads = await Promise.all(rawPayloads.map(
      (rawPayload) => parseSchema(
        worker.inputSchema,
        rawPayload,
        worker.validation.input,
      ),
    ));
    const requests: EnqueueJobRequest[] = payloads.map((payload) => ({
      queue: worker.queue,
      payload,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.correlation === undefined
        ? {}
        : { correlation: options.correlation }),
      ...(options.availableAt === undefined
        ? {}
        : { availableAt: options.availableAt }),
      ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
      ...(options.executionId === undefined
        ? {}
        : { executionId: options.executionId }),
    }));

    return this.adapter.enqueue(requests);
  }
}
