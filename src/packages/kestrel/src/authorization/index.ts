export * from "./adapters/index.js";
export {
  authorizationManagerDependency,
  permissionResolverDependency,
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
  PermissionDefinition,
  PermissionResolver,
  RoleDefinition,
  SubjectRoleStore,
} from "./types.js";
export * from "./resolvers/roles/index.js";
