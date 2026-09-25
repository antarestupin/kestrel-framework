import type {
  AuthorizationRequirement,
  PermissionDefinition,
} from "./types.js";

/** Requires one application permission. */
export function permission(
  definition: PermissionDefinition,
): AuthorizationRequirement {
  return Object.freeze({ type: "permission", permission: definition });
}

/** Requires every nested requirement. */
export function allOf(
  ...requirements: readonly AuthorizationRequirement[]
): AuthorizationRequirement {
  return group("all", requirements);
}

/** Requires at least one nested requirement. */
export function anyOf(
  ...requirements: readonly AuthorizationRequirement[]
): AuthorizationRequirement {
  return group("any", requirements);
}

function group(
  type: "all" | "any",
  requirements: readonly AuthorizationRequirement[],
): AuthorizationRequirement {
  if (requirements.length === 0) {
    throw new TypeError(`${type} authorization requirements must not be empty.`);
  }

  return Object.freeze({
    type,
    requirements: Object.freeze([...requirements]),
  });
}
