import { dep } from "../di/index.js";
import type { AuthorizationManager } from "./manager.js";
import type {
  PermissionResolver,
  SubjectRoleStorageAdapter,
} from "./types.js";

export const authorizationManagerDependency =
  dep<AuthorizationManager>("authorizationManager");
export const permissionResolverDependency =
  dep<PermissionResolver>("permissionResolver");
export const subjectRoleStoreDependency =
  dep<SubjectRoleStorageAdapter>("subjectRoleStore");
