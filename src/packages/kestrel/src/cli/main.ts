#!/usr/bin/env node
import { realpathSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import { waitForShutdownSignal } from "../app/process.js";
import type { ApplicationShutdownTimeoutError } from "../app/index.js";
import { loadApp, runCli } from "./runner.js";

/** Executes the generic CLI against an application module supplied by the project. */
export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  onShutdownTimeout?: (error: ApplicationShutdownTimeoutError) => void,
): Promise<number> {
  const [modulePath, ...commandArguments] = arguments_;

  if (modulePath === undefined) {
    throw new TypeError("An application module path is required.");
  }

  const app = await loadApp(modulePath);
  const signalWait = new AbortController();
  const unsubscribe = onShutdownTimeout === undefined ? undefined : app.shutdown.onTimeout(onShutdownTimeout);
  if (onShutdownTimeout !== undefined) {
    // Commands without a transport runtime still participate in graceful shutdown.
    void waitForShutdownSignal(signalWait.signal).then(() => {
      if (!signalWait.signal.aborted) void app.stop().catch(() => undefined);
    });
  }
  try {
    return await runCli(app, commandArguments);
  } finally {
    signalWait.abort();
    unsubscribe?.();
  }
}

/** npm executables are symlinks; compare their resolved target with this module. */
export function isExecutableEntrypoint(entrypoint: string | undefined, moduleUrl: string): boolean {
  return entrypoint !== undefined && moduleUrl === pathToFileURL(realpathSync(entrypoint)).href;
}

/** The executable owns termination, including when application diagnostics cannot finish. */
export function terminateExecutable(
  error: ApplicationShutdownTimeoutError,
  write: (descriptor: number, message: string) => number = writeSync,
): never {
  try { write(2, `${error.message} Forced process termination.\n`); }
  finally { process.exit(1); }
}

/** Run the executable without coupling embedded callers to process exit handling. */
export async function runExecutable(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await main(arguments_, terminateExecutable);
  } catch (error: unknown) {
    // Retain nested shutdown failures instead of hiding their causes behind [Array].
    console.error(inspect(error, { depth: null }));
    process.exitCode = 1;
  }
}

if (isExecutableEntrypoint(process.argv[1], import.meta.url)) {
  void runExecutable();
}
