import {
  postgresEmailCaptureConfigBase,
  type PostgresEmailCaptureConfig,
} from "./configuration.js";
import type { Pool } from "pg";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineEmailCaptureStorageAdapter } from "../../adapter_definition.js";
import { PostgresEmailCaptureStorageAdapter } from "./capture_store.js";

/** Borrows PostgreSQL infrastructure and prepares disposable development storage. */
export function postgresEmailCapture(
  connection: RegisteredDependencyDescriptor<{ readonly pool: Pool }>,
  settings: PostgresEmailCaptureConfig = postgresEmailCaptureConfigBase.schema.parse({}),
) {
  return defineEmailCaptureStorageAdapter({
    dependencies: { connection },
    capabilities: {},
    create: ({ connection }) => new PostgresEmailCaptureStorageAdapter(connection.pool),
    initialize: async (store) => {
      try {
        await store.prepare(settings.retentionDays);
      } catch (error) {
        // Missing development tables must not prevent maintenance commands from running.
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42P01"
        ))
          throw error;
      }
    },
  });
}
