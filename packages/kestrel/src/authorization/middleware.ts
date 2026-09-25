import { defineActionMiddleware } from "../actions/index.js";
import { dep } from "../di/index.js";
import { defineHttpMiddleware } from "../http/index.js";
import type { AuthorizationManager } from "./manager.js";
import type { AuthorizationRequirement } from "./types.js";

/** Protects one Action independently from its transport. */
export function requireAuthorization(
  requirement: AuthorizationRequirement,
) {
  return defineActionMiddleware("authorization.required", {
    dependencies: {
      authorizationManager: dep<AuthorizationManager>("authorizationManager"),
    },
    handler: async ({ deps }, next) => {
      await deps.authorizationManager.require(requirement);
      return next();
    },
  });
}

/** Protects an HTTP boundary before its controller handler executes. */
export function requireHttpAuthorization(
  requirement: AuthorizationRequirement,
) {
  return defineHttpMiddleware("authorization.http.required", {
    dependencies: {
      authorizationManager: dep<AuthorizationManager>("authorizationManager"),
    },
    handler: async ({ deps }, next) => {
      await deps.authorizationManager.require(requirement);
      return next();
    },
  });
}
