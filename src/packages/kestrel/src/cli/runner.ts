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
  const commandManager = new CliCommandManager(app, options);

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
  let exitCode: number;
  try {
    exitCode = await buildCli(app, options).run(arguments_);
  } catch (error: unknown) {
    // Command catalog construction can fail before parsing. Dispose the app
    // and retain the original failure alongside any shutdown diagnostics.
    try {
      await app.dispose();
    } catch (disposalError: unknown) {
      throw new AggregateError([error, disposalError], "CLI invocation and application disposal failed.");
    }
    throw error;
  }

  await app.dispose();
  return exitCode;
}

/** Loads the project-supplied application module without coupling Kestrel to it. */
export async function loadApp(modulePath: string): Promise<App<any>> {
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const loaded = await import(moduleUrl) as Record<string, unknown>;

  // Dynamic import always returns a module namespace object, even for CommonJS defaults.
  if (!("default" in loaded)) {
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
