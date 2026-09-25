import type { HttpMiddleware } from "./middleware.js";

/** Declares the mandatory access boundary applied to one HTTP controller. */
export interface HttpAccessPolicy {
  /** Stable name exposed to diagnostics and documentation tooling. */
  readonly name: string;
  /** Middleware entries that enforce this access boundary in declaration order. */
  readonly middleware: readonly HttpMiddleware<any, any>[];
}

/** Defines one explicit HTTP access policy without application coupling. */
export function defineHttpAccessPolicy(
  name: string,
  middleware: readonly HttpMiddleware<any, any>[] = [],
): HttpAccessPolicy {
  if (name.trim() === "") {
    throw new TypeError("An HTTP access policy name cannot be empty.");
  }

  return { name, middleware };
}

/** Rejects missing or malformed access policies at the definition boundary. */
export function validateHttpAccessPolicy(
  policy: HttpAccessPolicy,
): HttpAccessPolicy {
  if (
    typeof policy !== "object"
    || policy === null
    || typeof policy.name !== "string"
    || policy.name.trim() === ""
    || !Array.isArray(policy.middleware)
  ) {
    throw new TypeError("An HTTP controller requires a valid access policy.");
  }

  return policy;
}
