/** Waits without keeping the process alive and resolves early on shutdown. */
export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    timeout.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}
