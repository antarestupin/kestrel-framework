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

const entrypoint = process.argv[1];
// npm executables are symlinks; compare their resolved target with this module.
const isEntrypoint = entrypoint !== undefined
  && import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;

if (isEntrypoint) {
  main(process.argv.slice(2), (error) => {
    // The executable owns process termination. Never await application logging
    // after the deadline, and do not force exits from the embedded library API.
    try { writeSync(2, `${error.message} Forced process termination.\n`); }
    finally { process.exit(1); }
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      // Shutdown can nest several AggregateErrors; retain their leaf failures
      // instead of hiding the infrastructure cause behind `[Array]`.
      console.error(inspect(error, { depth: null }));
      process.exitCode = 1;
    });
}
