import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { App, shutdownCompletedEvent } from "../app/index.js";
import { defineCliController, loadApp, option, runCli } from "./index.js";

it.each([false, true])("disposes the application after catalog build failure (cleanup failure: %s)", async (failCleanup) => {
  const app = new App({});
  const completed = vi.fn();
  const cleanupError = new Error("Cleanup failed");
  app.eventBus.listen(shutdownCompletedEvent, completed);
  if (failCleanup) app.shutdown.registerDrain(async () => { throw cleanupError; });
  app.catalog.contribute({ controllers: { cli: {
    invalid: defineCliController({
      command: "invalid",
      input: z.object({ value: z.string() }),
      bindings: { value: option("invalid name") },
      handler: () => undefined,
    }),
  } } }, { kind: "application" });

  try {
    const invocation = runCli(app, ["invalid"]);
    const catalogError = 'Invalid CLI option name "invalid name".';
    if (failCleanup) {
      await expect(invocation).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ message: catalogError }),
          expect.objectContaining({ errors: [cleanupError] }),
        ],
      });
    } else {
      await expect(invocation).rejects.toThrow(catalogError);
    }
    expect(completed).toHaveBeenCalledOnce();
    expect(app.state).toBe("disposed");
  } finally {
    await app.dispose().catch(() => undefined);
  }
});

it.each([
  { source: "export const app = {};", message: "must export an App as default" },
  { source: "export default {};", message: "does not default-export an App instance" },
])("rejects a module with $source", async ({ source, message }) => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-module-"));
  try {
    const modulePath = join(directory, "application module.mjs");
    await writeFile(modulePath, source);
    await expect(loadApp(modulePath)).rejects.toThrow(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
