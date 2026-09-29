import type {
  PermissionDefinition,
  RoleDefinition,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_IDENTIFIER_LENGTH = 128;

/** Declares and validates one immutable application permission. */
export function definePermission(
  definition: PermissionDefinition,
): PermissionDefinition {
  validateIdentifier(definition.id, "Permission");

  return Object.freeze({
    id: definition.id,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
  });
}

/** Declares role metadata used by application setup and seed data. */
export function defineRole(definition: RoleDefinition): RoleDefinition {
  validateIdentifier(definition.key, "Role");

  if (definition.name.trim().length === 0) {
    throw new TypeError("Role name must not be empty.");
  }

  const permissionIds = new Set<string>();

  for (const permission of definition.permissions) {
    if (permissionIds.has(permission.id)) {
      throw new TypeError(
        `Role permission "${permission.id}" is declared more than once.`,
      );
    }

    permissionIds.add(permission.id);
  }

  return Object.freeze({
    key: definition.key,
    name: definition.name,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    permissions: Object.freeze([...definition.permissions]),
  });
}

function validateIdentifier(value: string, kind: string): void {
  if (
    value.length > MAX_IDENTIFIER_LENGTH
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${kind} identifier "${value}" must use lowercase dot- or dash-separated segments and be at most ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  }
}
