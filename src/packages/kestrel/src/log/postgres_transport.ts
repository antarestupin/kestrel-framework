import buildTransport from "pino-abstract-transport";
import {
  Pool,
  type PoolConfig,
} from "pg";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_RETENTION_DAYS = 7;

export interface PostgresTransportOptions extends PoolConfig {
  batchSize?: number;
  flushIntervalMs?: number;
  retentionDays?: number;
}

interface PinoLogEvent extends Record<string, unknown> {
  level?: number;
  msg?: string;
  reqId?: string;
  requestId?: string;
  time?: number;
  req?: {
    url?: string;
  };
}

/**
 * Creates the worker-owned Pino transport that persists local logs in
 * PostgreSQL. The worker owns its pool because Pino transport options cross a
 * structured-clone boundary and cannot contain the application's pool.
 */
export default async function createPostgresTransport(
  options: PostgresTransportOptions,
) {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    retentionDays = DEFAULT_RETENTION_DAYS,
    ...poolConfig
  } = options;
  const pool = new Pool({
    ...poolConfig,
    // Logging should not reserve more database connections than necessary.
    max: poolConfig.max ?? 2,
  });

  // Fail during transport initialization when the local database or its dev
  // migration is unavailable instead of silently discarding log events.
  await pool.query("select 1 from dev.log limit 1");
  await pool.query(
    "delete from dev.log where logged_at < now() - ($1 * interval '1 day')",
    [retentionDays],
  );

  return buildTransport(
    async (source) => {
      const iterator = source[Symbol.asyncIterator]();
      const batch: PinoLogEvent[] = [];
      const ignoredRequestIds = new Set<string>();
      let nextEvent = iterator.next();

      while (true) {
        const result = await Promise.race([
          nextEvent.then((event) => ({
            kind: "event" as const,
            event,
          })),
          wait(flushIntervalMs).then(() => ({
            kind: "flush" as const,
          })),
        ]);

        if (result.kind === "flush") {
          await insertBatch(pool, batch);
          continue;
        }

        if (result.event.done) {
          await insertBatch(pool, batch);
          break;
        }

        const event = result.event.value as PinoLogEvent;

        if (shouldPersist(event, ignoredRequestIds)) {
          batch.push(event);
        }

        nextEvent = iterator.next();

        if (batch.length >= batchSize) {
          await insertBatch(pool, batch);
        }
      }
    },
    {
      async close() {
        await pool.end();
      },
    },
  );
}

/**
 * Prevents the log viewer's own API traffic from recursively filling the
 * table. Fastify response logs only carry the request id, so ignored ids are
 * retained until their completion event is observed.
 */
function shouldPersist(
  event: PinoLogEvent,
  ignoredRequestIds: Set<string>,
): boolean {
  const requestId = typeof event.reqId === "string"
    ? event.reqId
    : typeof event.requestId === "string"
      ? event.requestId
      : undefined;
  const isLogApiRequest = event.req?.url?.includes(
    "/api/extensions/development-logs/logs",
  ) === true;

  if (isLogApiRequest && requestId !== undefined) {
    ignoredRequestIds.add(requestId);
  }

  if (requestId !== undefined && ignoredRequestIds.has(requestId)) {
    if (
      event.msg === "request completed"
      || event.msg === "request errored"
    ) {
      ignoredRequestIds.delete(requestId);
    }

    return false;
  }

  return !isLogApiRequest;
}

/**
 * Inserts one JSON batch in a single round trip. jsonb_to_recordset keeps the
 * SQL stable regardless of batch size and lets PostgreSQL perform the casts.
 */
async function insertBatch(
  pool: Pool,
  batch: PinoLogEvent[],
): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const rows = batch.splice(0).map((event) => ({
    loggedAt: new Date(
      typeof event.time === "number" ? event.time : Date.now(),
    ).toISOString(),
    level: typeof event.level === "number" ? event.level : 30,
    message: typeof event.msg === "string" ? event.msg : null,
    requestId: typeof event.reqId === "string"
      ? event.reqId
      : typeof event.requestId === "string"
        ? event.requestId
        : null,
    payload: event,
  }));

  await pool.query(
    `
      insert into dev.log (
        logged_at,
        level,
        message,
        request_id,
        payload
      )
      select
        entry.logged_at::timestamptz,
        entry.level,
        entry.message,
        entry.request_id,
        entry.payload
      from jsonb_to_recordset($1::jsonb) as entry(
        logged_at text,
        level integer,
        message text,
        request_id text,
        payload jsonb
      )
    `,
    [JSON.stringify(rows.map((row) => ({
      logged_at: row.loggedAt,
      level: row.level,
      message: row.message,
      request_id: row.requestId,
      payload: row.payload,
    })))],
  );
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
