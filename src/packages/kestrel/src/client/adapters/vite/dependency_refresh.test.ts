import { mkdtemp, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { watchInstalledDependencies } from "./dependency_refresh.js";

/** Real filesystem polling covers Docker-friendly detection without an HTTP server. */
describe("installed dependency refresh", () => {
  it("restarts after an installed receipt changes and disposes its watcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kestrel-dependencies-"));
    const receipt = join(directory, ".package-lock.json");
    await writeFile(receipt, "{}");
    const restart = vi.fn(async () => {});
    const report = vi.fn();
    const close = watchInstalledDependencies([receipt], restart, report);
    try {
      // A distinct timestamp makes this deterministic on filesystems with coarse clocks.
      const later = new Date(Date.now() + 10_000);
      await utimes(receipt, later, later);
      await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce(), { timeout: 4000 });
      expect(report).not.toHaveBeenCalled();
      close();
      await utimes(receipt, new Date(), new Date());
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      close();
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
