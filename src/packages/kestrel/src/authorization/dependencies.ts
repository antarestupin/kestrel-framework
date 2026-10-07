import { dep } from "../di/index.js";
import type { AuthorizationManager } from "./manager.js";
import type {
  PermissionResolver,
  SubjectRoleStore,
} from "./types.js";

export const authorizationManagerDependency =
  dep<AuthorizationManager>("authorizationManager");
export const permissionResolverDependency =
  dep<PermissionResolver>("permissionResolver");
export const subjectRoleStoreDependency =
  dep<SubjectRoleStore>("subjectRoleStore");
