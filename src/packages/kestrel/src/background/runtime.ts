import type { RuntimeApp } from "../app/index.js";
import { runSupervisedRuntime } from "../app/process.js";

export type BackgroundWorkload =
  | "scheduled-tasks"
  | "workers"
  | "workflows";

export interface BackgroundWorkloadRuntime {
  start(): Promise<void> | void;
  stop(): Promise<void>;
  readonly completion?: Promise<void> | undefined;
}

export interface BackgroundRuntimeOptions {
  waitForShutdown?: (signal: AbortSignal) => Promise<void>;
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

    await runSupervisedRuntime(this.app, {
      start: async (signal) => {
        for (const workload of selected) {
          if (signal?.aborted) return;
          const runtime = this.runtimes[workload]!;
          // Include partially started runtimes in cleanup after startup failure.
          started.push(runtime);
          const starting = Promise.resolve().then(() => runtime.start());
          const completions = started.flatMap((running) => running.completion === undefined ? [] : [running.completion]);
          await Promise.race([starting, ...completions.map((completion) => completion.then(() => {
            throw new Error("Background polling terminated during startup.");
          }))]);
        }
      },
      get completion() {
        const completions = started.flatMap((runtime) => runtime.completion === undefined ? [] : [runtime.completion]);
        return completions.length === 0 ? undefined : Promise.race(completions);
      },
      stop: async () => {
        const results = await Promise.allSettled([...started].reverse().map((runtime) => runtime.stop()));
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Background workload shutdown failed.");
      },
    }, this.options.waitForShutdown);
  }
}

export const backgroundWorkloads = ["workers", "scheduled-tasks", "workflows"] as const satisfies readonly BackgroundWorkload[];
