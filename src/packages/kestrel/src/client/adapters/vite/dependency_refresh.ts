import { watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** npm updates this installed-tree receipt after installation, unlike the source lockfile.
 * Poll explicitly because Vite ignores node_modules and Docker can lose filesystem events.
 */
export function refreshInstalledDependencies(projectRoot: string, files: readonly string[]): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    name: "kestrel:refresh-installed-dependencies",
    configureServer(server) {
      cleanup = watchInstalledDependencies(
        files.map((file) => resolve(projectRoot, file)),
        () => server.restart(),
        (error) => server.config.logger.error(`Dependency refresh failed: ${String(error)}`),
      );
    },
    // Vite closes the plugin container on shutdown and before restarting its graph.
    buildEnd() { cleanup?.(); cleanup = undefined; },
  };
}

/** Keep watcher ownership and restart sequencing testable without starting a server. */
export function watchInstalledDependencies(
  receipts: readonly string[],
  restart: () => Promise<unknown>,
  report: (error: unknown) => void,
) {
  let closed = false;
  let running = false;
  let pending = false;
  async function refresh() {
    if (closed) return;
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending && !closed) {
        pending = false;
        try { await restart(); } catch (error) { report(error); }
      }
    } finally { running = false; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (current: import("node:fs").Stats, previous: import("node:fs").Stats) => {
    // Ignore deletion during npm ci and wait for the final installed receipt instead.
    if (!current.mtimeMs || current.mtimeMs === previous.mtimeMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh();
    }, 300);
  };
  for (const receipt of new Set(receipts)) {
    watchFile(receipt, { persistent: false, interval: 1000 }, changed);
  }
  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
    for (const receipt of new Set(receipts)) unwatchFile(receipt, changed);
  };
  return cleanup;
}
