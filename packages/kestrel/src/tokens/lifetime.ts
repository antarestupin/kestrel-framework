import type { IssueTokenOptions } from "./types.js";

/** Resolves one explicit token lifetime without silently capping it. */
export function resolveTokenExpiration(
  options: IssueTokenOptions,
  now: Date,
): Date {
  if (
    options.ttlSeconds !== undefined
    && (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0)
  ) {
    throw new TypeError("Token ttlSeconds must be a positive integer.");
  }

  const expiresAt = options.expiresAt
    ?? new Date(now.getTime() + options.ttlSeconds * 1_000);

  if (
    Number.isNaN(expiresAt.getTime())
    || expiresAt.getTime() <= now.getTime()
  ) {
    throw new TypeError("Token expiration must be a valid future date.");
  }

  return expiresAt;
}
