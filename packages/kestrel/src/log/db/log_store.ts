import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  appWorkloads,
  type AppWorkload,
} from "../../app/workloads.js";
import {
  type DevLog,
  logs,
} from "./schema.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

export interface DevLogPageOptions {
  before?: number;
  level?: number;
  limit?: number;
  workload?: AppWorkload | "system";
}

export interface DevLogPage {
  items: readonly DevLog[];
  nextBefore: number | null;
}

export interface DevLogSource {
  clear(): Promise<void>;
  list(options?: DevLogPageOptions): Promise<DevLogPage>;
  /** Lists every persisted log correlated with one application execution. */
  listByExecution(executionId: string): Promise<readonly DevLog[]>;
  /** Lists logs for a bounded set of correlated application executions. */
  listByExecutions(executionIds: readonly string[]): Promise<readonly DevLog[]>;
}

/**
 * Database accepted by the store; this can evolve into a narrower query port
 * if the log persistence layer gains another adapter.
 */
export type DevLogDatabase = NodePgDatabase<{ logs: typeof logs }>;

/**
 * Reads development logs through an injected database while keeping their
 * Drizzle schema out of the application's main database type.
 */
export class DevLogStore implements DevLogSource {
  public constructor(private readonly database: DevLogDatabase) {}

  public async clear(): Promise<void> {
    await this.database.delete(logs);
  }

  public async list(
    options: DevLogPageOptions = {},
  ): Promise<DevLogPage> {
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const filters = [
      options.before === undefined
        ? undefined
        : lt(logs.id, options.before),
      options.level === undefined
        ? undefined
        : eq(logs.level, options.level),
      options.workload === undefined
        ? undefined
        : options.workload === "system"
          ? or(
              isNull(sql`${logs.payload}->>'workload'`),
              notInArray(
                sql<string>`${logs.payload}->>'workload'`,
                [...appWorkloads],
              ),
            )
          : eq(sql<string>`${logs.payload}->>'workload'`, options.workload),
    ].filter((filter) => filter !== undefined);
    const items = await this.database
      .select()
      .from(logs)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(logs.id))
      .limit(limit + 1);
    const hasNextPage = items.length > limit;
    const visibleItems = hasNextPage ? items.slice(0, limit) : items;

    return {
      items: visibleItems,
      nextBefore: hasNextPage
        ? (visibleItems.at(-1)?.id ?? null)
        : null,
    };
  }

  /** Reads an execution in emission order for its Studio detail section. */
  public async listByExecution(
    executionId: string,
  ): Promise<readonly DevLog[]> {
    return this.database
      .select()
      .from(logs)
      .where(sql`${logs.payload}->>'executionId' = ${executionId}`)
      .orderBy(asc(logs.id));
  }

  public async listByExecutions(
    executionIds: readonly string[],
  ): Promise<readonly DevLog[]> {
    if (executionIds.length === 0) return [];

    return this.database
      .select()
      .from(logs)
      .where(inArray(
        sql<string>`${logs.payload}->>'executionId'`,
        executionIds,
      ))
      .orderBy(asc(logs.id));
  }
}

/** Composes the log store with the PostgreSQL adapter used in production. */
export function createDevLogStore(pool: Pool): DevLogStore {
  return new DevLogStore(drizzle(pool, { schema: { logs } }));
}
