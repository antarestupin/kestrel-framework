/** Retry a later polling cycle after known transient database/transport failures. */
export function isRecoverablePostgresPollingError(error: unknown): boolean {
  const ancestors = new Set<object>();
  function inspect(value: unknown): boolean {
    if (value === null || typeof value !== "object" || ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      if (value instanceof AggregateError) return value.errors.length > 0 && value.errors.every(inspect);
      const candidate = value as { code?: unknown; cause?: unknown };
      if (typeof candidate.code === "string" && (
        candidate.code.startsWith("08")
        || ["40001", "40P01", "53300", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(candidate.code)
      )) return true;
      return inspect(candidate.cause);
    } finally {
      // Siblings can wrap the same cause without introducing a recursive cycle.
      ancestors.delete(value);
    }
  }
  return inspect(error);
}
