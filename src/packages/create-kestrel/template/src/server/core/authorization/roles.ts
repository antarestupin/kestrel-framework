import { defineRole } from "@kestreljs/framework/authorization/definition";
import { adminAccessPermission } from "./permissions.js";

/** Initial broad administrator role; finer capabilities can be added later. */
export const adminRole = defineRole({
  key: "admin",
  name: "Administrator",
  description: "Full access to the application administration.",
  permissions: [adminAccessPermission],
});

/** Complete code-defined catalog supplied to the application's role resolver. */
export const applicationRoles = Object.freeze([adminRole]);
