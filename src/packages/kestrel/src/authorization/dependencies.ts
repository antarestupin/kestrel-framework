import { dep } from "../di/index.js";
import type { AuthorizationManager } from "./manager.js";
import type {
  PermissionResolver,
  RoleStore,
  SubjectRoleStore,
} from "./types.js";

export const authorizationManagerDependency =
  dep<AuthorizationManager>("authorizationManager");
export const permissionResolverDependency =
  dep<PermissionResolver>("permissionResolver");
export const roleStoreDependency = dep<RoleStore>("roleStore");
export const subjectRoleStoreDependency =
  dep<SubjectRoleStore>("subjectRoleStore");
