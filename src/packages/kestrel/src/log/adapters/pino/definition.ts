import { defineLoggerAdapter } from "../../adapter_definition.js";
import { createLogger } from "../../logger.js";
/** Uses Pino's standard destination and owns its flush lifecycle. */
export function pinoLogger() {
  return defineLoggerAdapter({
    dependencies: {},
    capabilities: {},
    create: (_dependencies, { config }) => createLogger({ level: config.level }),
    dispose: (value) => value.close(),
  });
}
