import { fileURLToPath } from "node:url";
import type { HttpClientGenerationConfig } from "@kestrel/framework/http/client_generation";

/** Share one generation contract between the application and its generation command. */
export const httpClientGeneration = {
  audiences: { audiences: ["public"], defaultAudiences: ["public"] },
  generators: [{
    name: "public",
    audiences: ["public"],
    factoryName: "createPublicClient",
    // Resolve from this module so generation does not depend on the working directory.
    outputFile: fileURLToPath(new URL("../../generated/publicClient/publicClient.ts", import.meta.url)),
    catalogImportPath: "../../server/core/appCatalog.js",
    runtimeImportPath: "@kestrel/framework/http/client",
  }],
} satisfies HttpClientGenerationConfig;
