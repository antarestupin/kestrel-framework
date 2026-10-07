import { definePermission } from "@kestreljs/framework/authorization/definition";

/** Grants access to the complete application administration boundary. */
export const adminAccessPermission = definePermission({
  id: "admin.access",
  description: "Access the application administration.",
});
