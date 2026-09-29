import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

/** Load optional local defaults without overriding values supplied by the process. */
export function readEnvironment() {
  const environment = process.env.ENVIRONMENT
    ?? (process.env.NODE_ENV === "production" ? "prod" : process.env.NODE_ENV === "test" ? "test" : "local");
  if (environment === "local") {
    try {
      loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return environment;
}
