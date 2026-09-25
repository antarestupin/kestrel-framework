export * from "./adapters/index.js";
export {
  authorizationManagerDependency,
  permissionResolverDependency,
  roleStoreDependency,
  subjectRoleStoreDependency,
} from "./dependencies.js";
export { definePermission, defineRole } from "./definition.js";
export { AuthorizationDeniedError } from "./errors.js";
export {
  AuthorizationManager,
  type AuthorizationManagerDependencies,
} from "./manager.js";
export {
  requireAuthorization,
  requireHttpAuthorization,
} from "./middleware.js";
export { AuthorizationProvider } from "./provider.js";
export { allOf, anyOf, permission } from "./requirements.js";
export type {
  AuthorizationDecision,
  AuthorizationRequirement,
  AuthorizationRole,
  AuthorizationRoleState,
  PermissionDefinition,
  PermissionResolver,
  RoleDefinition,
  RoleStore,
  SubjectRoleStore,
} from "./types.js";
