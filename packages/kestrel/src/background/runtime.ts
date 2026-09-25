import type { RuntimeApp } from "../app/index.js";
import { waitForShutdownSignal } from "../app/process.js";

export type BackgroundWorkload =
  | "scheduled-tasks"
  | "workers"
  | "workflows";

export interface BackgroundWorkloadRuntime {
  start(): Promise<void> | void;
  stop(): Promise<void>;
}

export interface BackgroundRuntimeOptions {
  waitForShutdown?: () => Promise<void>;
}

/** Hosts any selected combination of Kestrel background schedulers. */
export class BackgroundRuntime<Config> {
  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly runtimes: Readonly<
      Partial<Record<BackgroundWorkload, BackgroundWorkloadRuntime>>
    >,
    private readonly options: BackgroundRuntimeOptions = {},
  ) {}

  public availableWorkloads(): readonly BackgroundWorkload[] {
    return backgroundWorkloads.filter((workload) =>
      this.runtimes[workload] !== undefined);
  }

  /** Starts only selected workloads and coordinates one graceful shutdown. */
  public async run(workloads: readonly BackgroundWorkload[]): Promise<void> {
    const selected = workloads.length === 0
      ? this.availableWorkloads()
      : [...new Set(workloads)];
    const unavailable = selected.find((workload) =>
      this.runtimes[workload] === undefined);

    if (unavailable !== undefined) {
      throw new TypeError(`Unavailable background workload: "${unavailable}".`);
    }

    const started: BackgroundWorkloadRuntime[] = [];

    try {
      for (const workload of selected) {
        const runtime = this.runtimes[workload]!;
        await runtime.start();
        started.push(runtime);
      }

      await (this.options.waitForShutdown ?? waitForShutdownSignal)();
    } finally {
      const results = await Promise.allSettled(
        [...started].reverse().map((runtime) => runtime.stop()),
      );
      const appStop = await Promise.allSettled([this.app.stop()]);
      const failures = [...results, ...appStop]
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected")
        .map((result) => result.reason);

      if (failures.length > 0) {
        throw new AggregateError(failures, "Background workload shutdown failed.");
      }
    }
  }
}

export const backgroundWorkloads = [
  "workers",
  "scheduled-tasks",
  "workflows",
] as const satisfies readonly BackgroundWorkload[];
