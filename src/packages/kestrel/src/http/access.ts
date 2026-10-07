import type { HttpMiddleware } from "./middleware.js";

/** Declares an access boundary applied to an HTTP controller. */
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

/** Unrestricted fallback used when a runtime does not configure default access. */
export const anonymousHttpAccess = defineHttpAccessPolicy("kestrel.http.anonymous");

/** Rejects malformed explicit policies at definition and composition boundaries. */
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
