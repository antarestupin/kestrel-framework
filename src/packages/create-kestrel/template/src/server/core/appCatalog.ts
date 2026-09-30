// Registers application actions and controllers and selects the HTTP client-generation catalog.
// Add feature catalogs here so their operations become available to the application.

import { defineCatalog, selectHttpControllerCatalog } from "@kestrel/framework/app";
import { exampleCatalog } from "../example/exampleCatalog.js";

export const appCatalog = defineCatalog({
  example: exampleCatalog,
});
export const applicationHttpControllerCatalog = selectHttpControllerCatalog(appCatalog);
