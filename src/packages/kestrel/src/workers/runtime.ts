import type { Logger } from "pino";

import type { RuntimeApp } from "../app/index.js";
import { waitForShutdownSignal } from "../app/process.js";
import type { WorkersConfig } from "./configuration.js";
import { WorkerScheduler } from "./scheduler.js";
import type { WorkerAdapter } from "./types.js";
import type { WorkerCorrelatedCompletionSink } from "./dependencies.js";
import type {
  AdmissionPolicyDefinition,
  Throttling,
} from "../throttling/index.js";

/** Owns worker polling and graceful draining for one application. */
export class WorkerRuntime<Config> {
  public readonly scheduler: WorkerScheduler<Config>;

  private stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    adapter: WorkerAdapter,
    config: WorkersConfig,
    logger: Logger,
    throttling?: Throttling,
    reservationPressure?: AdmissionPolicyDefinition,
    completionSink?: WorkerCorrelatedCompletionSink,
  ) {
    this.scheduler = new WorkerScheduler(
      app,
      adapter,
      app.catalog.workers.definitions,
      {
        ...config,
        ...(throttling === undefined ? {} : { throttling }),
        ...(reservationPressure === undefined
          ? {}
          : { reservationPressure }),
        reportError: (error) => {
          logger.error({ err: error }, "Worker scheduler cycle failed");
        },
        ...(completionSink === undefined
          ? {}
          : {
              completeCorrelatedJob: (completion) =>
                completionSink.complete(completion),
            }),
      },
    );
  }

  /** Starts polling and waits until the process requests shutdown. */
  public async run(): Promise<void> {
    this.start();

    try {
      await waitForShutdownSignal();
    } finally {
      try {
        await this.stop();
      } finally {
        await this.app.stop();
      }
    }
  }

  /** Starts polling without owning process-signal coordination. */
  public start(): void {
    this.scheduler.start();
  }

  /** Drains worker executions; a composite runtime owns application stop. */
  public stop(): Promise<void> {
    this.stopPromise ??= this.scheduler.stop();

    return this.stopPromise;
  }
}
