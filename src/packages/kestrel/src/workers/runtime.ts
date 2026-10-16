import type { Logger } from "pino";

import type { RuntimeApp } from "../app/index.js";
import { runSupervisedRuntime } from "../app/process.js";
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
    app.shutdown.registerDrain(() => this.stop());
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

  /** Retains polling termination independently of successful startup. */
  public get completion(): Promise<void> | undefined { return this.scheduler.completion; }

  public async run(): Promise<void> {
    const owner = this;
    await runSupervisedRuntime(this.app, {
      start: () => this.start(),
      stop: () => this.stop(),
      get completion() { return owner.completion; },
    });
  }

  /** Starts polling without owning process-signal coordination. */
  public start(): void {
    if (this.stopPromise !== undefined) throw new Error("Worker runtime has stopped.");
    this.scheduler.start();
  }

  /** Drains worker executions; a composite runtime owns application stop. */
  public stop(): Promise<void> {
    this.stopPromise ??= this.app.shutdown.wait("worker drain", async () => {
      // Non-waiting scheduler policies may return while pre-scope storage is
      // still pending. The runtime keeps borrowed infrastructure alive for it.
      const results = await Promise.allSettled([this.scheduler.stop(), this.scheduler.completion]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Worker drain failed.");
    });

    return this.stopPromise;
  }
}
