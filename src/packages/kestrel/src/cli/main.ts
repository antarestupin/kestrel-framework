#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadApp, runCli } from "./runner.js";

/** Executes the generic CLI against an application module supplied by the project. */
export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const [modulePath, ...commandArguments] = arguments_;

  if (modulePath === undefined) {
    throw new TypeError("An application module path is required.");
  }

  return runCli(await loadApp(modulePath), commandArguments);
}

const entrypoint = process.argv[1];
// npm executables are symlinks; compare their resolved target with this module.
const isEntrypoint = entrypoint !== undefined
  && import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;

if (isEntrypoint) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
