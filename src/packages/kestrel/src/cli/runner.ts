import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { App } from "../app/index.js";
import {
  CliCommandManager,
  type CliCommandManagerOptions,
} from "./command_manager.js";

/** Builds the complete command catalog declared by an application. */
export function buildCli<Config>(
  app: App<Config>,
  options: CliCommandManagerOptions = {},
): CliCommandManager<Config> {
  const commandManager = new CliCommandManager(app, {
    name: "do",
    ...options,
  });

  for (const controller of app.catalog.cliControllers.definitions) {
    commandManager.register(controller);
  }

  return commandManager;
}

/** Runs one CLI invocation and always releases application resources. */
export async function runCli<Config>(
  app: App<Config>,
  arguments_: readonly string[],
  options: CliCommandManagerOptions = {},
): Promise<number> {
  const cli = buildCli(app, options);

  try {
    return await cli.run(arguments_);
  } finally {
    await app.dispose();
  }
}

/** Loads the project-supplied application module without coupling Kestrel to it. */
export async function loadApp(modulePath: string): Promise<App<any>> {
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const loaded: unknown = await import(moduleUrl);

  if (
    typeof loaded !== "object"
    || loaded === null
    || !("default" in loaded)
  ) {
    throw new TypeError(
      `Application module "${modulePath}" must export an App as default.`,
    );
  }

  const app: unknown = loaded.default;

  if (!(app instanceof App)) {
    throw new TypeError(
      `Application module "${modulePath}" does not default-export an App instance.`,
    );
  }

  return app as App<any>;
}
