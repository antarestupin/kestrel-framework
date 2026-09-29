import { defineHttpAccessPolicy } from "../http/access.js";

/** Explicit unrestricted policy shared by Kestrel HTTP unit tests. */
export const testHttpAccess = defineHttpAccessPolicy("test.http.unrestricted");
