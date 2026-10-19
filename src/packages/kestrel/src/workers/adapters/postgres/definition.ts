import { defineWorkerAdapter } from "../../adapter_definition.js";
import { PostgresWorkerAdapter, type PostgresWorkerDatabase } from "./adapter.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";

/** Creates a queue adapter lazily; borrowed infrastructure retains its owner. */
export function postgresWorkers(database: RegisteredDependencyDescriptor<PostgresWorkerDatabase>) {
  return defineWorkerAdapter({
    dependencies: { database },
    capabilities: {},
    create: ({ database }, config) => new PostgresWorkerAdapter(
      database, undefined, undefined, undefined, config.publication,
    ),
  });
}
