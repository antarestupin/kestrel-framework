import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";

import type { PostgresDrizzleManager } from "../../../db/index.js";
import type {
  CreateStoredToken,
  StoredToken,
  StoredTokenLookup,
  StoredTokenRevocation,
  StoredTokenSubjectMutation,
  TokenPruneOptions,
  TokenStorageAdapter,
} from "../../types.js";
import type { PostgresTokenTable } from "./tables.js";

/** PostgreSQL persistence over the default or an application-supplied table. */
export class PostgresTokenStorageAdapter implements TokenStorageAdapter {
  public constructor(
    private readonly databaseManager: PostgresDrizzleManager,
    private readonly table: PostgresTokenTable,
  ) {}

  public async createMany(tokens: readonly CreateStoredToken[]): Promise<void> {
    if (tokens.length === 0) return;
    validateReplacementBatch(tokens);

    await this.databaseManager.transaction(async () => {
      const replacements = tokens.filter(
        (token) => token.replaceExistingForSubject,
      );

      if (replacements.length > 0) {
        await this.database
          .update(this.table)
          .set({ revokedAt: replacements[0]!.createdAt })
          .where(and(
            isNull(this.table.consumedAt),
            isNull(this.table.revokedAt),
            or(...replacements.map((token) => and(
              eq(this.table.definition, token.definition),
              eq(this.table.subject, token.subject!),
            ))),
          ));
      }

      await this.database.insert(this.table).values(tokens.map((token) => ({
        id: token.id,
        definition: token.definition,
        subject: token.subject ?? null,
        subjectExclusive: token.replaceExistingForSubject,
        digest: Buffer.from(token.digest),
        payload: token.payload,
        expiresAt: token.expiresAt,
        consumedAt: token.consumedAt ?? null,
        revokedAt: token.revokedAt ?? null,
        createdAt: token.createdAt,
      })));
    });
  }

  public async findValid(
    input: StoredTokenLookup,
  ): Promise<StoredToken | undefined> {
    const [token] = await this.database
      .select(tokenSelection(this.table))
      .from(this.table)
      .where(validTokenWhere(this.table, input))
      .limit(1);

    return token === undefined ? undefined : mapToken(token);
  }

  public async consume(
    input: StoredTokenLookup,
  ): Promise<StoredToken | undefined> {
    const [token] = await this.database
      .update(this.table)
      .set({ consumedAt: input.now })
      .where(validTokenWhere(this.table, input))
      .returning(tokenSelection(this.table));

    return token === undefined ? undefined : mapToken(token);
  }

  public async revoke(input: StoredTokenRevocation): Promise<boolean> {
    const revoked = await this.database
      .update(this.table)
      .set({ revokedAt: input.revokedAt })
      .where(validTokenWhere(this.table, input))
      .returning({ id: this.table.id });

    return revoked.length > 0;
  }

  public async revokeForSubject(
    input: StoredTokenSubjectMutation,
  ): Promise<number> {
    const revoked = await this.database
      .update(this.table)
      .set({ revokedAt: input.now })
      .where(and(
        eq(this.table.definition, input.definition),
        eq(this.table.subject, input.subject),
        gt(this.table.expiresAt, input.now),
        isNull(this.table.consumedAt),
        isNull(this.table.revokedAt),
      ))
      .returning({ id: this.table.id });

    return revoked.length;
  }

  public async deleteForSubject(
    input: StoredTokenSubjectMutation,
  ): Promise<number> {
    const deleted = await this.database
      .delete(this.table)
      .where(and(
        eq(this.table.definition, input.definition),
        eq(this.table.subject, input.subject),
      ))
      .returning({ id: this.table.id });

    return deleted.length;
  }

  public async prune(options: TokenPruneOptions): Promise<number> {
    const candidates = await this.database
      .select({ id: this.table.id })
      .from(this.table)
      .where(or(
        lte(this.table.expiresAt, options.expiredBefore),
        lte(this.table.consumedAt, options.inactiveBefore),
        lte(this.table.revokedAt, options.inactiveBefore),
      ))
      .orderBy(asc(this.table.createdAt), asc(this.table.id))
      .limit(options.limit);

    if (candidates.length === 0) return 0;

    const deleted = await this.database
      .delete(this.table)
      .where(inArray(this.table.id, candidates.map(({ id }) => id)))
      .returning({ id: this.table.id });

    return deleted.length;
  }

  private get database(): PostgresDrizzleManager["database"] {
    return this.databaseManager.database;
  }
}

function validateReplacementBatch(tokens: readonly CreateStoredToken[]): void {
  const replacements = new Set<string>();

  for (const token of tokens) {
    if (!token.replaceExistingForSubject) continue;
    if (token.subject === undefined) {
      throw new TypeError("Replacement tokens require a subject.");
    }

    const replacement = `${token.definition}\0${token.subject}`;

    if (replacements.has(replacement)) {
      throw new TypeError(
        "A token batch cannot replace the same definition and subject more than once.",
      );
    }
    replacements.add(replacement);
  }
}

function tokenSelection(table: PostgresTokenTable) {
  return {
    id: table.id,
    definition: table.definition,
    subject: table.subject,
    digest: table.digest,
    payload: table.payload,
    expiresAt: table.expiresAt,
    consumedAt: table.consumedAt,
    revokedAt: table.revokedAt,
    createdAt: table.createdAt,
  };
}

function validTokenWhere(
  table: PostgresTokenTable,
  input: StoredTokenLookup,
) {
  return and(
    eq(table.definition, input.definition),
    eq(table.digest, Buffer.from(input.digest)),
    gt(table.expiresAt, input.now),
    isNull(table.consumedAt),
    isNull(table.revokedAt),
  );
}

interface SelectedToken {
  id: string;
  definition: string;
  subject: string | null;
  digest: Buffer;
  payload: unknown;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function mapToken(token: SelectedToken): StoredToken {
  return {
    id: token.id,
    definition: token.definition,
    ...(token.subject === null ? {} : { subject: token.subject }),
    digest: token.digest,
    payload: token.payload,
    expiresAt: token.expiresAt,
    ...(token.consumedAt === null ? {} : { consumedAt: token.consumedAt }),
    ...(token.revokedAt === null ? {} : { revokedAt: token.revokedAt }),
    createdAt: token.createdAt,
  };
}
