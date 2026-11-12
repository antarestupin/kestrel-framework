import { watchFile, unwatchFile, type Stats } from "node:fs";
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

type ReceiptChange = (current: Stats, previous: Stats) => void;

interface ReceiptWatcher {
  watchFile(path: string, options: { persistent: boolean; interval: number }, change: ReceiptChange): void;
  unwatchFile(path: string, change: ReceiptChange): void;
}

/** Keep watcher ownership and restart sequencing testable without starting a server. */
export function watchInstalledDependencies(
  receipts: readonly string[],
  restart: () => Promise<unknown>,
  report: (error: unknown) => void,
  watcher: ReceiptWatcher = { watchFile, unwatchFile },
) {
  // Close the exact paths that this subscription opened, even if the caller changes the list.
  const watchedReceipts = new Set(receipts);
  let closed = false;
  let running = false;
  let pending: boolean;
  async function refresh() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        try { await restart(); } catch (error) { report(error); }
      } while (pending && !closed);
    } finally { running = false; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed: ReceiptChange = (current, previous) => {
    // Ignore deletion during npm ci and wait for the final installed receipt instead.
    if (closed || !current.mtimeMs || current.mtimeMs === previous.mtimeMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh();
    }, 300);
  };
  for (const receipt of watchedReceipts) {
    watcher.watchFile(receipt, { persistent: false, interval: 1000 }, changed);
  }
  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
    for (const receipt of watchedReceipts) watcher.unwatchFile(receipt, changed);
  };
  return cleanup;
}
