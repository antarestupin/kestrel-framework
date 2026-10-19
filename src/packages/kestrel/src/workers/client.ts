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
import {
  resolveWorkerPublicationBudgets,
  WorkerPublicationBudgetGuard,
  type WorkerPublicationBudgets,
} from "./publication.js";

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
  private readonly budgets: WorkerPublicationBudgets;

  public constructor(private readonly adapter: WorkerAdapter, budgets: WorkerPublicationBudgets = {}) {
    this.budgets = resolveWorkerPublicationBudgets(budgets);
  }

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
    // Reject count overflow before application schemas or serializers run.
    const guard = new WorkerPublicationBudgetGuard(this.budgets, rawPayloads.length);
    if (options.identity !== undefined && rawPayloads.length > 1) {
      throw new TypeError(
        "A stable Worker identity can only describe one enqueued job.",
      );
    }

    // Prepare progressively so byte overflow stops work on subsequent jobs.
    const requests: EnqueueJobRequest[] = [];
    for (const rawPayload of rawPayloads) {
      const payload = await parseSchema(
        worker.inputSchema,
        rawPayload,
        worker.validation.input,
      );
      requests.push(guard.snapshot({
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
    }

    // External adapters receive the same JSON representation as built-in ones.
    return this.adapter.enqueue(requests);
  }
}
