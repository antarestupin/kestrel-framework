import { createRequire } from "node:module";

// Use the same CommonJS driver instance as pg's bound Pool class.
const require = createRequire(import.meta.url);
const pg = require("pg");
const installedGuard = Symbol.for("kestrel.testing.postgresDestinationGuard");

/** Resolve the approved test destination without consulting mutable framework schemas. */
export function resolvePostgresTestDestination(environment = process.env) {
  const destination = {
    host: environment.DB_HOST ?? "localhost",
    port: Number(environment.DB_PORT ?? environment.KESTREL_POSTGRES_PORT ?? 55432),
    user: environment.DB_USER ?? "postgres",
    database: environment.KESTREL_TEST_DATABASE ?? "kestrel_test",
  };
  if (
    ![destination.host, destination.user, destination.database]
      .every((value) => typeof value === "string" && value.length > 0)
    || !Number.isInteger(destination.port)
    || destination.port < 1
    || destination.port > 65_535
  ) {
    throw new TypeError("Kestrel PostgreSQL tests require a valid dedicated test destination.");
  }
  return Object.freeze(destination);
}

/** Reject changed routing instead of repairing configuration and hiding real mutants. */
export function guardPostgresConnect(originalConnect, destination) {
  return function guardedPostgresConnect(callback) {
    const parameters = this.connectionParameters;
    // pg connects with the client fields but sends startup identity from connectionParameters.
    const matches = [this, parameters].every((value) => value
      && value.host === destination.host
      && value.port === destination.port
      && value.user === destination.user
      && value.database === destination.database);
    if (!matches) {
      const error = Object.assign(
        new Error("Kestrel tests blocked a PostgreSQL connection outside the configured test destination."),
        { code: "KESTREL_TEST_POSTGRES_DESTINATION" },
      );
      // Pool uses callbacks and must receive the error so it can remove the unconnected client.
      if (typeof callback === "function") {
        queueMicrotask(() => callback(error));
        return undefined;
      }
      return Promise.reject(error);
    }
    return Reflect.apply(originalConnect, this, arguments);
  };
}

/** Install once per shared driver instance, including when Vitest runs without isolation. */
export function installPostgresDestinationGuard(environment = process.env) {
  const prototype = pg.Client.prototype;
  if (prototype[installedGuard]) return;
  const destination = resolvePostgresTestDestination(environment);
  prototype.connect = guardPostgresConnect(prototype.connect, destination);
  Object.defineProperty(prototype, installedGuard, { value: true });
}
