import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ClientBase,
  Pool,
  QueryConfig,
  QueryResult,
} from "pg";

import type { ObservationValue } from "../observability/index.js";
import type { DatabaseConfig } from "./configuration.js";
import type {
  DatabaseQueryInstrumentation,
  DatabaseQueryObservationData,
  DatabaseQueryOrigin,
} from "./observations.js";

type QueryObservabilityConfig = DatabaseConfig["queryObservability"];
type QueryFunction = (...arguments_: unknown[]) => unknown;

const instrumentedClients = new WeakSet<ClientBase>();
const instrumentedPools = new WeakSet<Pool>();
const queryContext = new AsyncLocalStorage<PoolQueryContext>();

interface PoolQueryContext {
  origin: DatabaseQueryOrigin | undefined;
}

/** Instruments every physical connection created by an application pool. */
export function instrumentPostgresPool(
  pool: Pool,
  config: QueryObservabilityConfig,
  getInstrumentation: () => DatabaseQueryInstrumentation | undefined,
): void {
  if (instrumentedPools.has(pool)) {
    return;
  }

  instrumentedPools.add(pool);
  const query = pool.query.bind(pool) as QueryFunction;

  pool.on("connect", (client) => {
    instrumentPostgresClient(
      client,
      config,
      getInstrumentation,
      () => queryContext.getStore(),
    );
  });

  // Capture before pg-pool crosses its asynchronous connection callback.
  pool.query = ((...arguments_: unknown[]) => {
    if (getInstrumentation() === undefined) {
      return query(...arguments_);
    }

    // Drizzle builders carry the earlier repository call site when available.
    if (queryContext.getStore() !== undefined) {
      return query(...arguments_);
    }

    return queryContext.run(
      { origin: captureQueryOrigin(config.origin) },
      () => query(...arguments_),
    );
  }) as Pool["query"];
}

/** Captures Drizzle builder creation before its thenable crosses an async boundary. */
export function instrumentDrizzleDatabase<Database extends object>(
  database: Database,
  config: QueryObservabilityConfig,
  getInstrumentation: () => DatabaseQueryInstrumentation | undefined,
): Database {
  const nestedProxies = new WeakMap<object, object>();

  return createDatabaseProxy(database);

  function createDatabaseProxy<Value extends object>(value: Value): Value {
    const existing = nestedProxies.get(value);

    if (existing !== undefined) {
      return existing as Value;
    }

    const proxy = new Proxy(value, {
      get: (target, property) => {
        const member = Reflect.get(target, property, target) as unknown;

        if (typeof member === "function") {
          return (...arguments_: unknown[]) => {
            if (getInstrumentation() === undefined) {
              return Reflect.apply(member, target, arguments_);
            }

            const context: PoolQueryContext = {
              origin: captureQueryOrigin(config.origin),
            };
            const invocationArguments = property === "transaction"
              ? wrapTransactionCallback(arguments_, context)
              : arguments_;

            return queryContext.run(context, () => wrapQueryBuilder(
              Reflect.apply(member, target, invocationArguments),
              context,
            ));
          };
        }

        // Relational queries start below database.query.<table>.
        if (property === "query" && isObject(member)) {
          return createNestedDatabaseProxy(member);
        }

        return member;
      },
    });

    nestedProxies.set(value, proxy);

    return proxy;
  }

  function createNestedDatabaseProxy<Value extends object>(value: Value): Value {
    const existing = nestedProxies.get(value);

    if (existing !== undefined) {
      return existing as Value;
    }

    const proxy = new Proxy(value, {
      get: (target, property) => {
        const member = Reflect.get(target, property, target) as unknown;

        if (typeof member === "function") {
          return (...arguments_: unknown[]) => {
            if (getInstrumentation() === undefined) {
              return Reflect.apply(member, target, arguments_);
            }

            const context: PoolQueryContext = {
              origin: captureQueryOrigin(config.origin),
            };

            return queryContext.run(context, () => wrapQueryBuilder(
              Reflect.apply(member, target, arguments_),
              context,
            ));
          };
        }

        return isObject(member) ? createNestedDatabaseProxy(member) : member;
      },
    });

    nestedProxies.set(value, proxy);

    return proxy;
  }

  function wrapTransactionCallback(
    arguments_: readonly unknown[],
    context: PoolQueryContext,
  ): unknown[] {
    const [callback, ...rest] = arguments_;

    if (typeof callback !== "function") {
      return [...arguments_];
    }

    return [
      (transaction: object) => queryContext.run(
        context,
        () => Reflect.apply(callback, undefined, [
          createDatabaseProxy(transaction),
        ]),
      ),
      ...rest,
    ];
  }
}

/** Keeps the captured builder origin active when Drizzle eventually executes it. */
function wrapQueryBuilder<Value>(
  value: Value,
  context: PoolQueryContext,
): Value {
  if (!isObject(value) || value instanceof Promise) {
    return value;
  }

  return new Proxy(value, {
    get: (target, property) => {
      const member = Reflect.get(target, property, target) as unknown;

      if (typeof member !== "function") {
        return member;
      }

      return (...arguments_: unknown[]) => queryContext.run(context, () => {
        const result = Reflect.apply(member, target, arguments_);

        return property === "then"
          ? result
          : wrapQueryBuilder(result, context);
      });
    },
  }) as Value;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null)
    || typeof value === "function";
}

/** Wraps a PostgreSQL client while preserving promise and callback query APIs. */
export function instrumentPostgresClient(
  client: ClientBase,
  config: QueryObservabilityConfig,
  getInstrumentation: () => DatabaseQueryInstrumentation | undefined,
  getPoolQueryContext?: () => PoolQueryContext | undefined,
): void {
  if (instrumentedClients.has(client)) {
    return;
  }

  instrumentedClients.add(client);
  const query = client.query.bind(client) as QueryFunction;

  client.query = ((...arguments_: unknown[]) => {
    const instrumentation = getInstrumentation();
    const queryDetails = readQueryDetails(arguments_);

    if (instrumentation === undefined || queryDetails === undefined) {
      return query(...arguments_);
    }

    const startedAt = performance.now();
    const poolQueryContext = getPoolQueryContext?.();
    const origin = poolQueryContext === undefined
      ? captureQueryOrigin(config.origin)
      : poolQueryContext.origin;
    const callbackIndex = findCallbackIndex(arguments_);

    if (callbackIndex !== undefined) {
      const callback = arguments_[callbackIndex] as QueryFunction;
      const wrappedArguments = [...arguments_];

      wrappedArguments[callbackIndex] = (
        error: unknown,
        result: QueryResult | undefined,
      ) => {
        recordQuery(
          instrumentation,
          queryDetails,
          config,
          startedAt,
          origin,
          error,
          result,
        );

        return callback(error, result);
      };

      return query(...wrappedArguments);
    }

    let result: unknown;

    try {
      result = query(...arguments_);
    } catch (error: unknown) {
      recordQuery(
        instrumentation,
        queryDetails,
        config,
        startedAt,
        origin,
        error,
      );
      throw error;
    }

    if (isPromiseLike<QueryResult>(result)) {
      return result.then(
        (queryResult) => {
          recordQuery(
            instrumentation,
            queryDetails,
            config,
            startedAt,
            origin,
            undefined,
            queryResult,
          );

          return queryResult;
        },
        (error: unknown) => {
          recordQuery(
            instrumentation,
            queryDetails,
            config,
            startedAt,
            origin,
            error,
          );
          throw error;
        },
      );
    }

    return result;
  }) as ClientBase["query"];
}

interface QueryDetails {
  sql: string;
  parameters: readonly unknown[];
  statementName?: string;
}

/** Reads the overloads used by node-postgres and Drizzle prepared queries. */
function readQueryDetails(arguments_: readonly unknown[]): QueryDetails | undefined {
  const [query, values] = arguments_;

  if (typeof query === "string") {
    return {
      sql: query,
      parameters: Array.isArray(values) ? values : [],
    };
  }

  if (!isQueryConfig(query)) {
    return undefined;
  }

  return {
    sql: query.text,
    parameters: Array.isArray(values)
      ? values
      : Array.isArray(query.values) ? query.values : [],
    ...(query.name === undefined ? {} : { statementName: query.name }),
  };
}

function isQueryConfig(value: unknown): value is QueryConfig {
  return typeof value === "object"
    && value !== null
    && "text" in value
    && typeof value.text === "string";
}

function findCallbackIndex(arguments_: readonly unknown[]): number | undefined {
  for (let index = arguments_.length - 1; index >= 1; index -= 1) {
    if (typeof arguments_[index] === "function") {
      return index;
    }
  }

  return undefined;
}

function isPromiseLike<Value>(value: unknown): value is PromiseLike<Value> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

/** Builds JSON-safe observation data without ever interpolating SQL values. */
function createObservationData(
  query: QueryDetails,
  config: QueryObservabilityConfig,
  origin: DatabaseQueryOrigin | undefined,
  error: unknown,
  result: QueryResult | undefined,
): DatabaseQueryObservationData {
  const errorCode = readPostgresErrorCode(error);

  return {
    sql: query.sql,
    ...(config.parameters === "include" && query.parameters.length > 0
      ? { parameters: query.parameters.map(toObservationValue) }
      : {}),
    ...(query.statementName === undefined
      ? {}
      : { statementName: query.statementName }),
    ...(result?.command === undefined ? {} : { command: result.command }),
    ...(result?.rowCount === null || result?.rowCount === undefined
      ? {}
      : { rowCount: result.rowCount }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(origin === undefined ? {} : { origin }),
  };
}

function recordQuery(
  instrumentation: DatabaseQueryInstrumentation,
  query: QueryDetails,
  config: QueryObservabilityConfig,
  startedAt: number,
  origin: DatabaseQueryOrigin | undefined,
  error?: unknown,
  result?: QueryResult,
): void {
  try {
    // node-postgres callback queries use null, not undefined, for success.
    const succeeded = error === undefined || error === null;

    instrumentation.record({
      data: createObservationData(query, config, origin, error, result),
      durationMs: performance.now() - startedAt,
      outcome: succeeded ? "success" : "failure",
    });
  } catch {
    // Diagnostic capture must never change the result of an application query.
  }
}

function readPostgresErrorCode(error: unknown): string | undefined {
  return typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Converts arbitrary driver values to the storage-neutral JSON data contract. */
function toObservationValue(value: unknown): ObservationValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue);

    if (serialized !== undefined) {
      return JSON.parse(serialized) as ObservationValue;
    }
  } catch {
    // Fall back to a bounded representation for cyclic or custom values.
  }

  return String(value);
}

interface StackFrame {
  function?: string;
  file: string;
  line: number;
  column: number;
  rendered: string;
}

/** Captures only application frames so driver internals stay out of Studio. */
function captureQueryOrigin(
  mode: QueryObservabilityConfig["origin"],
): DatabaseQueryOrigin | undefined {
  if (mode === "none") {
    return undefined;
  }

  const frames = new Error().stack
    ?.split("\n")
    .slice(1)
    .map(parseStackFrame)
    .filter((frame): frame is StackFrame =>
      frame !== undefined && isApplicationFrame(frame.file)) ?? [];
  const caller = frames[0];

  if (caller === undefined) {
    return undefined;
  }

  return {
    ...(caller.function === undefined ? {} : { function: caller.function }),
    file: caller.file,
    line: caller.line,
    column: caller.column,
    ...(mode === "stack"
      ? { stack: frames.map((frame) => frame.rendered) }
      : {}),
  };
}

function parseStackFrame(line: string): StackFrame | undefined {
  const trimmed = line.trim();
  const match = /^at (?:(.*?) \()?(.+):(\d+):(\d+)\)?$/.exec(trimmed);

  if (match === null) {
    return undefined;
  }

  const functionName = match[1];
  const file = match[2];
  const lineNumber = match[3];
  const columnNumber = match[4];

  if (file === undefined || lineNumber === undefined || columnNumber === undefined) {
    return undefined;
  }

  return {
    ...(functionName === undefined ? {} : { function: functionName }),
    file,
    line: Number(lineNumber),
    column: Number(columnNumber),
    rendered: trimmed,
  };
}

function isApplicationFrame(file: string): boolean {
  return !file.includes("/node_modules/")
    && !file.startsWith("node:")
    // Match the owned module independently of checkout and package directory names.
    && !/\/db\/query_instrumentation\.(?:[cm]?[jt]s)$/.test(file);
}
