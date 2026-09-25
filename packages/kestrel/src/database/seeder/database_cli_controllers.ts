import { z } from "zod";

import { defineCliController } from "../../cli/index.js";
import { dep } from "../../di/index.js";
import type { DatabaseMaintenance } from "./database_maintenance.js";

const databaseMaintenanceDependency = dep<DatabaseMaintenance>(
  "databaseMaintenance",
);
const messageSchema = z.object({ message: z.string() });

export const databaseCliControllers = {
  migrate: defineCliController({
    command: "database migrate",
    description: "Apply application and Kestrel database migrations.",
    observe: false,
    runningMode: "minimal",
    output: messageSchema,
    dependencies: { maintenance: databaseMaintenanceDependency },
    handler: async ({ deps }) => {
      await deps.maintenance.migrate();
      return { message: "Database migrated." };
    },
  }),
  seed: defineCliController({
    command: "database seed",
    description: "Populate the local database with application resources.",
    output: messageSchema,
    dependencies: { maintenance: databaseMaintenanceDependency },
    handler: async ({ deps }) => {
      await deps.maintenance.seed();
      return { message: "Database seeded." };
    },
  }),
  reset: defineCliController({
    command: "database reset",
    description: "Clear and migrate the local database from scratch.",
    observe: false,
    runningMode: "minimal",
    output: messageSchema,
    dependencies: { maintenance: databaseMaintenanceDependency },
    handler: async ({ deps }) => {
      await deps.maintenance.reset();
      return { message: "Database reset." };
    },
  }),
  resetSeed: defineCliController({
    command: "database reset-seed",
    description: "Reset the local database and populate application resources.",
    observe: false,
    runningMode: "minimal",
    output: messageSchema,
    dependencies: { maintenance: databaseMaintenanceDependency },
    handler: async ({ deps }) => {
      await deps.maintenance.resetAndSeed();
      return { message: "Database reset and seeded." };
    },
  }),
} as const;
