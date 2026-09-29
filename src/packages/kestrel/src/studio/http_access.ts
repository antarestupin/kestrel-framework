import { defineHttpAccessPolicy } from "../http/index.js";

/** Marks Studio routes as intentionally unrestricted inside its local runtime. */
export const studioHttpAccess = defineHttpAccessPolicy(
  "studio.http.unrestricted",
);
