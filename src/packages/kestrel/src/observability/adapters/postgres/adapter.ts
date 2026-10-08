import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  executionCompletedObservation,
  executionStartedObservation,
  type ExecutionTransport,
} from "../../../app/observations.js";
import type { ObservationData } from "../../definitions.js";
import type { ObservationEvent, ObservationOutcome } from "../../observer.js";
import type { ObservationWriter } from "../../recorder.js";
import { observations, type StoredObservation } from "../../db/schema.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

import type {
  DevObservationSource,
  ObservationExecutionSummary,
  ObservationExecutionPageOptions,
  ObservationExecutionPage,
  ObservationPageOptions,
  ObservationPage,
} from "../../source.js";
export type {
  DevObservationSource,
  ObservationExecutionSummary,
  ObservationExecutionPageOptions,
  ObservationExecutionPage,
  ObservationPageOptions,
} from "../../source.js";

/** Reads and writes local observations without polluting the deployed schema. */
export class PostgresObservationStore implements ObservationWriter, DevObservationSource {
  private readonly database: NodePgDatabase<{
    observations: typeof observations;
  }>;

  public constructor(private readonly pool: Pool) {
    this.database = drizzle(pool, { schema: { observations } });
  }

  /** Verifies the development table and prunes expired observations. */
  public async prepare(retentionDays: number): Promise<void> {
    await this.pool.query("select 1 from dev.observation limit 1");
    await this.pool.query(
      "delete from dev.observation where occurred_at < now() - ($1 * interval '1 day')",
      [retentionDays],
    );
  }

  public async append(events: readonly ObservationEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.database.insert(observations).values(
      events.map((event) => ({
        id: event.id,
        executionId: event.executionId,
        occurredAt: event.occurredAt,
        name: event.name,
        category: event.category,
        schemaVersion: event.schemaVersion,
        data: event.data,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      })),
    );
  }

  public async clear(): Promise<void> {
    await this.database.delete(observations);
  }

  public async getObservation(id: string): Promise<StoredObservation | undefined> {
    const [observation] = await this.database
      .select()
      .from(observations)
      .where(eq(observations.id, id))
      .limit(1);

    return observation;
  }

  public async listEvents(executionId: string): Promise<readonly StoredObservation[]> {
    return this.database
      .select()
      .from(observations)
      .where(eq(observations.executionId, executionId))
      .orderBy(asc(observations.occurredAt), asc(observations.sequence));
  }

  /** Lists every event from executions sharing one diagnostic correlation. */
  public async listEventsByContext(
    contextKey: string,
    contextValue: string,
  ): Promise<readonly StoredObservation[]> {
    // Lifecycle events carry the diagnostic context, while observations emitted
    // inside that scope (for example database queries) only need its execution
    // identity. Resolve the correlated identities first, then return their full
    // timelines in one SQL statement.
    const correlatedExecutionIds = this.database
      .select({ executionId: observations.executionId })
      .from(observations)
      .where(sql`${observations.data}->'context'->>${contextKey} = ${contextValue}`);

    return this.database
      .select()
      .from(observations)
      .where(inArray(observations.executionId, correlatedExecutionIds))
      .orderBy(asc(observations.occurredAt), asc(observations.sequence));
  }

  /** Lists observations newest first with exact, index-friendly filters. */
  public async listObservations(options: ObservationPageOptions = {}): Promise<ObservationPage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const items = await this.database
      .select()
      .from(observations)
      .where(
        and(
          options.before === undefined ? undefined : lt(observations.sequence, options.before),
          options.category === undefined ? undefined : eq(observations.category, options.category),
          options.executionId === undefined
            ? undefined
            : eq(observations.executionId, options.executionId),
          options.name === undefined ? undefined : eq(observations.name, options.name),
          options.outcome === undefined ? undefined : eq(observations.outcome, options.outcome),
        ),
      )
      .orderBy(desc(observations.sequence))
      .limit(limit + 1);
    const hasNextPage = items.length > limit;
    const visibleItems = hasNextPage ? items.slice(0, limit) : items;

    return {
      items: visibleItems,
      nextBefore: hasNextPage ? (visibleItems.at(-1)?.sequence ?? null) : null,
    };
  }

  public async listExecutions(
    options: ObservationExecutionPageOptions = {},
  ): Promise<ObservationExecutionPage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const starts = await this.database
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.name, executionStartedObservation.name),
          options.before === undefined ? undefined : lt(observations.sequence, options.before),
        ),
      )
      .orderBy(desc(observations.sequence))
      .limit(limit + 1);
    const hasNextPage = starts.length > limit;
    const visibleStarts = hasNextPage ? starts.slice(0, limit) : starts;
    const executionIds = visibleStarts.map((event) => event.executionId);
    const completions =
      executionIds.length === 0
        ? []
        : await this.database
            .select()
            .from(observations)
            .where(
              and(
                eq(observations.name, executionCompletedObservation.name),
                inArray(observations.executionId, executionIds),
              ),
            )
            .orderBy(desc(observations.sequence));
    const completionByExecution = new Map(completions.map((event) => [event.executionId, event]));

    return {
      items: visibleStarts.map((start) => {
        const completion = completionByExecution.get(start.executionId);
        const startData = readExecutionData(start.data);

        return {
          executionId: start.executionId,
          operation: startData.operation,
          transport: startData.transport,
          startedAt: start.occurredAt,
          completedAt: completion?.occurredAt ?? null,
          outcome: completion?.outcome ?? null,
          durationMs: completion?.durationMs ?? null,
        };
      }),
      nextBefore: hasNextPage ? (visibleStarts.at(-1)?.sequence ?? null) : null,
    };
  }
}

function readExecutionData(data: ObservationData): {
  operation: string;
  transport: ExecutionTransport;
} {
  const operation = data.operation;
  const transport = data.transport;

  return {
    operation: typeof operation === "string" ? operation : "Unknown execution",
    transport: isExecutionTransport(transport) ? transport : "direct",
  };
}

function isExecutionTransport(value: unknown): value is ExecutionTransport {
  return value === "cli" || value === "direct" || value === "http" || value === "worker";
}
