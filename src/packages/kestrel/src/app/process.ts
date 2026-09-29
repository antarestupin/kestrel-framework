/** Resolves when the process receives its first graceful shutdown signal. */
export function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
