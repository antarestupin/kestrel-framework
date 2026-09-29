import type {
  AnyPgColumn,
  AnyPgTable,
} from "drizzle-orm/pg-core";

type StringColumn = AnyPgColumn<{ data: string; notNull: true }>;
type NumberColumn = AnyPgColumn<{ data: number; notNull: true }>;
type DateColumn = AnyPgColumn<{ data: Date; notNull: true }>;
type NullableDateColumn = AnyPgColumn<{ data: Date; notNull: false }>;
type NullableStringColumn = AnyPgColumn<{ data: string; notNull: false }>;
type BytesColumn = AnyPgColumn<{ data: Buffer; notNull: true }>;
type StringArrayColumn = AnyPgColumn<{ data: string[]; notNull: true }>;
type JsonColumn = AnyPgColumn<{ data: unknown; notNull: true }>;

export type PostgresAuthenticationAccountTable = AnyPgTable & {
  id: StringColumn;
  subjectId: StringColumn;
  state: StringColumn;
  securityVersion: NumberColumn;
  createdAt: DateColumn;
  updatedAt: DateColumn;
};

export type PostgresPasswordCredentialTable = AnyPgTable & {
  id: StringColumn;
  accountId: StringColumn;
  username: StringColumn;
  normalizedUsername: StringColumn;
  passwordHash: StringColumn;
  passwordChangedAt: DateColumn;
  createdAt: DateColumn;
  updatedAt: DateColumn;
};

export type PostgresAuthenticationSessionTable = AnyPgTable & {
  id: StringColumn;
  accountId: StringColumn;
  tokenDigest: BytesColumn;
  claims: JsonColumn;
  accountSecurityVersion: NumberColumn;
  authenticationMethod: StringColumn;
  authenticationFactors: StringArrayColumn;
  authenticatedAt: DateColumn;
  createdAt: DateColumn;
  lastSeenAt: DateColumn;
  idleExpiresAt: DateColumn;
  absoluteExpiresAt: DateColumn;
  revokedAt: NullableDateColumn;
  revokeReason: NullableStringColumn;
  ipAddress: NullableStringColumn;
  userAgent: NullableStringColumn;
};

/** Application-supplied tables keep subject foreign keys outside Kestrel. */
export interface PostgresAuthenticationTables {
  readonly accounts: PostgresAuthenticationAccountTable;
  readonly passwordCredentials: PostgresPasswordCredentialTable;
  readonly sessions: PostgresAuthenticationSessionTable;
}
