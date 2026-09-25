import { dep } from "../di/index.js";
import type { WorkerClient } from "./client.js";
import type { WorkerAdapter } from "./types.js";
import type { WorkerCorrelatedCompletion } from "./types.js";
import type { WorkerRuntime } from "./runtime.js";

/** Application-owned queue API available to every transport. */
export const workerClientDependency = dep<WorkerClient>("workerClient");

/** Storage adapter resolved by the dedicated worker scheduler bootstrap. */
export const workerAdapterDependency = dep<WorkerAdapter>("workerAdapter");

/** Long-running worker transport prepared by the worker provider. */
export const workerRuntimeDependency = dep<WorkerRuntime<any>>("workerRuntime");

/** Optional owner for terminal results emitted by correlated jobs. */
export interface WorkerCorrelatedCompletionSink {
  complete(completion: WorkerCorrelatedCompletion): Promise<void>;
}

/** Routes correlated terminal results without coupling Workers to owners. */
export class WorkerCorrelatedCompletionRouter
implements WorkerCorrelatedCompletionSink {
  private readonly sinks = new Map<string, WorkerCorrelatedCompletionSink>();

  public constructor(
    sinks: Readonly<Record<string, WorkerCorrelatedCompletionSink>> = {},
  ) {
    for (const [namespace, sink] of Object.entries(sinks)) {
      this.register(namespace, sink);
    }
  }

  public register(
    namespace: string,
    sink: WorkerCorrelatedCompletionSink,
  ): void {
    if (namespace.length === 0) {
      throw new TypeError("Worker correlation namespaces cannot be empty.");
    }
    if (this.sinks.has(namespace)) {
      throw new TypeError(
        `Worker correlation namespace "${namespace}" is already registered.`,
      );
    }
    this.sinks.set(namespace, sink);
  }

  public complete(completion: WorkerCorrelatedCompletion): Promise<void> {
    const sink = this.sinks.get(completion.correlation.namespace);
    if (sink === undefined) {
      throw new Error(
        `No Worker completion sink handles namespace "${completion.correlation.namespace}".`,
      );
    }
    return sink.complete(completion);
  }
}

export const workerCorrelatedCompletionSinkDependency =
  dep<WorkerCorrelatedCompletionSink>("workerCorrelatedCompletionSink");
