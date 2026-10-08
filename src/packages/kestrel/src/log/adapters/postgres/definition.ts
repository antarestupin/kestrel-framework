import type { Pool } from "pg";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import type { LoggerAdapterDefinition } from "../../adapter_definition.js";
import {
  createLogger,
  createDevLogger,
  createDelegatingLogger,
  type LoggerDatabaseConfig,
  type OwnedLogger,
} from "../../logger.js";

/** Retains Pino compatibility and selects development storage only after its readiness check. */
export function postgresLogger(
  connection: RegisteredDependencyDescriptor<{ readonly pool: Pool }>,
  settings: LoggerDatabaseConfig,
): LoggerAdapterDefinition {
  return {
    capabilities: {},
    create: (resolve, { config, bootPlan }) => {
      let active = createLogger({ level: config.level });
      return {
        logger: createDelegatingLogger(() => active.logger),
        close: () => active.close(),
        prepare: async () => {
          if (bootPlan.runningMode === "minimal") return;
          try {
            await resolve(connection).pool.query("select 1 from dev.log limit 1");
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "42P01"
            )
              return;
            throw error;
          }
          const next = createDevLogger(settings, { level: config.level });
          const previous = active;
          // Retain ownership of the new destination even if the fallback fails to close.
          active = next;
          await previous.close();
        },
      };
    },
    initialize: (value) => (value as OwnedLogger & { prepare(): Promise<void> }).prepare(),
    dispose: (value) => value.close(),
  };
}
