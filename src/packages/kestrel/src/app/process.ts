import type { RuntimeApp } from "./app.js";

/** Resolves on a process signal or owner cancellation, always removing listeners. */
export function waitForShutdownSignal(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) return resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export interface SupervisedRuntime {
  start(signal?: AbortSignal): Promise<void> | void;
  stop(): Promise<void>;
  /** Settles on polling termination, independently of successful startup. */
  readonly completion?: Promise<void> | undefined;
}

/** Coordinates failures and signals with the application's single shutdown budget. */
export async function runSupervisedRuntime<Config>(
  app: RuntimeApp<Config>,
  runtime: SupervisedRuntime,
  wait: (signal: AbortSignal) => Promise<void> = waitForShutdownSignal,
): Promise<void> {
  const signalWait = new AbortController();
  const errors: unknown[] = [];
  try {
    // Install signal listeners before asynchronous runtime initialization.
    const startup = Promise.resolve().then(() => runtime.start(signalWait.signal));
    const shutdownRequested = wait(signalWait.signal);
    const started = await Promise.race([startup.then(() => true), shutdownRequested.then(() => false)]);
    if (started) {
      const completion = runtime.completion?.then(() => {
        throw new Error("Runtime polling terminated before shutdown was requested.");
      });
      await Promise.race([shutdownRequested, ...(completion === undefined ? [] : [completion])]);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    signalWait.abort();
    app.shutdown.begin();
    // Close admission synchronously before transports start draining. Do not
    // await stop listeners before requesting that every poller stops admission.
    const appStop = app.stop();
    const results = await Promise.allSettled([
      appStop,
      app.shutdown.wait("runtime drain", () => runtime.stop()),
    ]);
    for (const result of results) if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Runtime failed or shutdown was incomplete.");
}
