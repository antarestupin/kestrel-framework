/** Retry a later polling cycle after known transient database/transport failures. */
export function isRecoverablePostgresPollingError(error: unknown): boolean {
  const seen = new Set<unknown>();
  function inspect(value: unknown): boolean {
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (value instanceof AggregateError) return value.errors.length > 0 && value.errors.every(inspect);
    const candidate = value as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && (
      candidate.code.startsWith("08")
      || ["40001", "40P01", "53300", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(candidate.code)
    )) return true;
    return inspect(candidate.cause);
  }
  return inspect(error);
}
