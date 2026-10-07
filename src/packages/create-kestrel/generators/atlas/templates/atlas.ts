import { defineAtlas } from "@kestreljs/framework/atlas";

/** Register explicit application resources here; no catalog or table is exposed automatically. */
export const applicationBackoffice = defineAtlas({
  title: "Administration",
  basePath: "/admin",
  resources: [],
});
