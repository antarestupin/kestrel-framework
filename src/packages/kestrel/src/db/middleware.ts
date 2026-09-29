import { defineActionMiddleware } from "../actions/middleware.js";
import { dep } from "../di/index.js";
import { DatabaseManager } from "./database_manager.js";

/** Runs the remaining action pipeline in the scoped database transaction. */
export const databaseTransaction = defineActionMiddleware(
  "database.transaction",
  {
    dependencies: {
      databaseManager: dep<DatabaseManager>("databaseManager"),
    },
    handler: ({ deps }, next) => {
      return deps.databaseManager.transaction(next);
    },
  },
);
