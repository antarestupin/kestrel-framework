import { mkdtemp, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { refreshInstalledDependencies, watchInstalledDependencies } from "./dependency_refresh.js";

/** Real filesystem polling covers Docker-friendly detection without an HTTP server. */
describe("installed dependency refresh", () => {
  it("restarts through the Vite plugin and disposes its watcher when the graph closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kestrel-dependencies-"));
    const receipt = join(directory, ".package-lock.json");
    const failure = new Error("restart failed");
    const restart = vi.fn(async () => { throw failure; });
    const error = vi.fn();
    const plugin = refreshInstalledDependencies(directory, [".package-lock.json"]);
    const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
    const buildEnd = plugin.buildEnd as () => void;
    try {
      await writeFile(receipt, "{}");
      configureServer({ restart, config: { logger: { error } } } as unknown as ViteDevServer);
      // The first stat is asynchronous. Continue changing the timestamp until polling sees an update.
      const later = new Date(Date.now() + 10_000);
      await vi.waitFor(async () => {
        if (restart.mock.calls.length === 0) {
          later.setTime(later.getTime() + 1_000);
          await utimes(receipt, later, later);
        }
        expect(error).toHaveBeenCalledExactlyOnceWith("Dependency refresh failed: Error: restart failed");
      }, { interval: 200, timeout: 4_000 });
      expect(restart).toHaveBeenCalledOnce();
      buildEnd();
      await utimes(receipt, new Date(), new Date());
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      buildEnd();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("waits for a missing receipt, coalesces updates and reports restart failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-dependencies-"));
  const receipt = join(directory, "installed.json");
  const failure = new Error("Restart failed");
  const restart = vi.fn(async () => { throw failure; });
  const report = vi.fn();
  const close = watchInstalledDependencies([receipt, receipt], restart, report);
  try {
    // A missing receipt must not cause a restart; creation represents completed installation.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(restart).not.toHaveBeenCalled();
    await writeFile(receipt, "{}");
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(failure), { timeout: 4000 });
    expect(restart).toHaveBeenCalledOnce();
  } finally {
    close();
    await rm(directory, { recursive: true, force: true });
  }
});
