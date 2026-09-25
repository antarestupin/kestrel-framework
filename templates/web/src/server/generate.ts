import { writeHttpClient } from "@kestrel/framework/http/client_generation";
import { applicationHttpControllerCatalog } from "./core/appCatalog.js";

// Client generation only loads definitions; no database or listening server is needed.
await writeHttpClient({
  catalog: applicationHttpControllerCatalog, name: "public", audiences: ["public"],
  controllerAudiences: { audiences: ["public"], defaultAudiences: ["public"] },
  factoryName: "createPublicClient", outputFile: "src/client/api.ts",
  catalogImportPath: "../server/core/appCatalog.js", runtimeImportPath: "@kestrel/framework/http/client",
});
