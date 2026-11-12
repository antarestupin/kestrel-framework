import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

import { ApplicationShutdownTimeoutError, type App } from "../app/index.js";
import { isExecutableEntrypoint, main, runExecutable, terminateExecutable } from "./main.js";

it("requires an application module path", async () => {
  await expect(main([])).rejects.toThrow("An application module path is required.");
});

it("runs an embedded invocation against a module path containing spaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-embedded-"));
  try {
    const fixture = join(directory, "application module.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({});
      app.catalog.contribute({ controllers: { cli: {
        embedded: defineCliController({ command: "embedded", handler: () => undefined }),
      } } }, { kind: "application" });
      export default app;
    `);
    const timeout = vi.fn();
    const signalListeners = process.listeners("SIGTERM");
    await expect(main([fixture, "embedded"], timeout)).resolves.toBe(0);
    expect(timeout).not.toHaveBeenCalled();
    expect(process.listeners("SIGTERM")).toEqual(signalListeners);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses the process arguments when no embedded arguments are supplied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-arguments-"));
  const originalArguments = process.argv;
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({});
      app.catalog.contribute({ controllers: { cli: {
        embedded: defineCliController({ command: "embedded", handler: () => undefined }),
      } } }, { kind: "application" });
      export default app;
    `);
    const signals = process.listenerCount("SIGTERM");
    process.argv = [...originalArguments.slice(0, 2), fixture, "embedded"];
    await expect(main()).resolves.toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(signals);
  } finally {
    process.argv = originalArguments;
    await rm(directory, { recursive: true, force: true });
  }
});

it("stops the loaded app on a shutdown signal and cleans up its subscriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-signal-"));
  const originalListeners = process.listeners("SIGTERM");
  let app: App<{}> | undefined;
  let resume: (() => void) | undefined;
  let invocation: Promise<number> | undefined;
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({});
      const started = Promise.withResolvers();
      const finish = Promise.withResolvers();
      export const ready = started.promise;
      export const resume = finish.resolve;
      app.catalog.contribute({ controllers: { cli: {
        hold: defineCliController({ command: "hold", handler: async () => {
          started.resolve();
          await finish.promise;
        } }),
      } } }, { kind: "application" });
      export default app;
    `);
    const loaded = await import(pathToFileURL(fixture).href) as {
      default: App<{}>; ready: Promise<void>; resume: () => void;
    };
    app = loaded.default;
    resume = loaded.resume;
    const timeout = vi.fn();
    const unsubscribe = vi.fn();
    const subscription = vi.spyOn(app.shutdown, "onTimeout").mockReturnValue(unsubscribe);
    const stop = vi.spyOn(app, "stop").mockRejectedValueOnce(new Error("Signal shutdown failed"));
    invocation = main([fixture, "hold"], timeout);
    try {
      // Invoke only this command's listener so the Vitest process keeps its own signal handlers.
      await Promise.race([loaded.ready, invocation.then(() => { throw new Error("Command did not start"); })]);
      const listeners = process.listeners("SIGTERM").filter((listener) => !originalListeners.includes(listener));
      expect(listeners).toHaveLength(1);
      listeners[0]!("SIGTERM");
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 100 });
      expect(subscription).toHaveBeenCalledExactlyOnceWith(timeout);
    } finally {
      stop.mockRestore();
      subscription.mockRestore();
    }
    resume();
    await expect(invocation).resolves.toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(process.listeners("SIGTERM")).toEqual(originalListeners);
  } finally {
    resume?.();
    await invocation?.catch(() => undefined);
    await app?.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

it("identifies the executable through a package bin symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-bin-"));
  try {
    const entry = join(directory, "main.mjs");
    const executable = join(directory, "do");
    await writeFile(entry, "");
    await symlink(entry, executable);
    const resolvedEntry = pathToFileURL(await realpath(entry)).href;
    expect(isExecutableEntrypoint(undefined, resolvedEntry)).toBe(false);
    expect(isExecutableEntrypoint(executable, resolvedEntry)).toBe(true);
    expect(isExecutableEntrypoint(entry, pathToFileURL(executable).href)).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([false, true])("forcibly exits when diagnostic writing fails: %s", (writeFails) => {
  const termination = new Error("Exit requested");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw termination; });
  const write = vi.fn(() => {
    if (writeFails) throw new Error("Diagnostic unavailable");
    return 0;
  });
  try {
    const deadline = new ApplicationShutdownTimeoutError("command", 25);
    expect(() => terminateExecutable(deadline, write)).toThrow(termination);
    expect(write).toHaveBeenCalledExactlyOnceWith(2, `${deadline.message} Forced process termination.\n`);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally { exit.mockRestore(); }
});

it("propagates a command's exit code from process arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-cli-exit-code-"));
  const exitCode = process.exitCode;
  const originalArguments = process.argv;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({});
      app.catalog.contribute({ controllers: { cli: {
        available: defineCliController({ command: "available", handler: () => undefined }),
      } } }, { kind: "application" });
      export default app;
    `);
    process.argv = [...originalArguments.slice(0, 2), fixture, "unavailable"];
    await runExecutable();
    expect(process.exitCode).toBe(2);
    expect(stderr.mock.calls.flat().join("")).toContain("unknown command 'unavailable'");
  } finally {
    stderr.mockRestore();
    process.argv = originalArguments;
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

it("the executable prints leaf errors nested beneath shutdown aggregates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-diagnostics-"));
  const exitCode = process.exitCode;
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      const app = new App({});
      // Disposal adds another aggregate around this nested polling failure.
      app.shutdown.registerDrain(async () => {
        throw new AggregateError([
          new AggregateError([new Error("Missing workflow task relation")], "Polling failed"),
        ], "Workflow drain failed");
      });
      export default app;
    `);
    await runExecutable([fixture, "--help"]);
    expect(process.exitCode).toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Missing workflow task relation"));
    expect(report.mock.calls[0]?.[0]).not.toContain("[Array]");

    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./main.ts", import.meta.url)), fixture, "--help"], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Missing workflow task relation");
    expect(result.stderr).not.toContain("[Array]");
  } finally {
    stdout.mockRestore();
    report.mockRestore();
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

it("the executable exits at its deadline even when a command and diagnostic sink never finish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-shutdown-"));
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({}, { shutdown: { timeoutMs: 40, drainMs: 10 } });
      app.container.registerValue("observationRecorder", { flush: () => new Promise(() => {}) });
      app.catalog.contribute({ fixture: { controllers: { cli: {
        hang: defineCliController({ command: "hang", description: "Exercise bounded shutdown", observe: false,
          handler: async () => {
            // This live resource makes setting exitCode alone insufficient.
            setInterval(() => {}, 1000);
            setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
            await new Promise(() => {});
          },
        }),
      } } } });
      export default app;
    `);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./main.ts", import.meta.url)), fixture, "hang"], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Forced process termination.");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
