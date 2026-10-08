import {
  postgresObservationsConfigBase,
  type PostgresObservationsConfig,
} from "./configuration.js";
import type { Pool } from "pg";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineObservationAdapter } from "../../adapter_definition.js";
import { PostgresObservationStore } from "./adapter.js";

/** Prepares optional development storage while retaining ownership of the borrowed pool externally. */
export function postgresObservations(
  connection: RegisteredDependencyDescriptor<{ readonly pool: Pool }>,
  settings: PostgresObservationsConfig = postgresObservationsConfigBase.schema.parse({}),
) {
  return defineObservationAdapter({
    dependencies: { connection },
    capabilities: { query: true },
    create: ({ connection }) => {
      const store = new PostgresObservationStore(connection.pool);
      return { writer: store, source: store, available: true as boolean };
    },
    initialize: async (adapter) => {
      try {
        await adapter.source.prepare(settings.retentionDays);
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42P01"
        ))
          throw error;
        adapter.available = false;
      }
    },
  });
}
