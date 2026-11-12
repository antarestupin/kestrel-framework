import { unwatchFile, watchFile, type Stats } from "node:fs";
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
      unwatchFile(receipt);
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
    unwatchFile(receipt);
    await rm(directory, { recursive: true, force: true });
  }
});

it("releases the originally watched receipts if the input list is later edited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-receipt-ownership-"));
  const receipt = join(directory, "original.json");
  const paths = [receipt];
  const watcher = watchFile(receipt, { persistent: false }, () => undefined);
  const close = watchInstalledDependencies(paths, async () => {}, () => {});
  try {
    expect(watcher.listenerCount("change")).toBe(2);
    paths[0] = join(directory, "replacement.json");
    close();
    expect(watcher.listenerCount("change")).toBe(1);
  } finally {
    close();
    unwatchFile(receipt);
    await rm(directory, { recursive: true, force: true });
  }
});

it("debounces metadata changes and queues one follow-up while a restart is running", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<void>();
  const restart = vi.fn(async () => {}).mockImplementationOnce(() => first.promise);
  let receipt: ReturnType<typeof fakeReceiptWatcher> | undefined;
  try {
    receipt = fakeReceiptWatcher(restart);
    receipt.change(0, 10);
    receipt.change(10, 10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restart).not.toHaveBeenCalled();
    receipt.change(10, 0);
    await vi.advanceTimersByTimeAsync(150);
    receipt.change(11, 10);
    await vi.advanceTimersByTimeAsync(299);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();

    for (const time of [12, 13]) {
      receipt.change(time, time - 1);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(restart).toHaveBeenCalledOnce();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(2);
    receipt.change(14, 13);
    await vi.advanceTimersByTimeAsync(300);
    expect(restart).toHaveBeenCalledTimes(3);
  } finally {
    receipt?.close();
    first.resolve();
    vi.useRealTimers();
  }
});

it("cancels the debounce and queued restart on close, including an already queued watcher callback", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<void>();
  const restart = vi.fn(() => first.promise);
  let receipt: ReturnType<typeof fakeReceiptWatcher> | undefined;
  try {
    receipt = fakeReceiptWatcher(restart);
    receipt.change(1, 0);
    await vi.advanceTimersByTimeAsync(300);
    receipt.change(2, 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(restart).toHaveBeenCalledOnce();
    receipt.change(3, 2);
    expect(vi.getTimerCount()).toBe(1);

    receipt.close();
    expect(vi.getTimerCount()).toBe(0);
    receipt.change(4, 3);
    expect(vi.getTimerCount()).toBe(0);
    first.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(restart).toHaveBeenCalledOnce();
    expect(receipt.unwatch).toHaveBeenCalledExactlyOnceWith("installed.json", expect.any(Function));
  } finally {
    receipt?.close();
    first.resolve();
    vi.useRealTimers();
  }
});

/** Exercise the real scheduling decisions without waiting on the OS polling interval. */
function fakeReceiptWatcher(restart: () => Promise<void>) {
  type Change = (current: Stats, previous: Stats) => void;
  const watch = vi.fn<(path: string, options: { persistent: boolean; interval: number }, change: Change) => void>();
  const unwatch = vi.fn<(path: string, change: Change) => void>();
  const close = watchInstalledDependencies(["installed.json", "installed.json"], restart, vi.fn(), {
    watchFile: watch, unwatchFile: unwatch,
  });
  expect(watch).toHaveBeenCalledExactlyOnceWith("installed.json", { persistent: false, interval: 1000 }, expect.any(Function));
  const listener = watch.mock.calls[0]![2];
  return {
    change: (current: number, previous: number) => listener({ mtimeMs: current } as Stats, { mtimeMs: previous } as Stats),
    close,
    unwatch,
  };
}
