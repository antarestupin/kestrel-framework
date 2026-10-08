export { PostgresAuthenticationAdapter } from "./adapter.js";
export {
  authenticationAccounts,
  authenticationPasswordCredentials,
  authenticationSessions,
  authenticationSqlSchema,
  authenticationTables,
} from "./schema.js";
export type {
  PostgresAuthenticationAccountTable,
  PostgresAuthenticationSessionTable,
  PostgresAuthenticationTables,
  PostgresPasswordCredentialTable,
} from "./tables.js";

export * from "./definition.js";
