import { once } from "node:events";
import type { ConnectionOptions } from "node:tls";
import { fileURLToPath } from "node:url";
import pino, {
  type Logger,
  type LoggerOptions,
  type TransportSingleOptions,
} from "pino";
import {
  appWorkloads,
  type AppWorkload,
} from "../app/workloads.js";
import type { ExecutionContext } from "../app/index.js";

/** Destination interpreted as structured execution log bindings. */
export const executionContextLogDestination = "log";

export interface ExecutionLogContextFields {
  readonly operation?: string;
  readonly transport?: string;
  readonly workload?: AppWorkload;
  readonly executionContext?: Readonly<Record<string, unknown>>;
}

export interface LoggerDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Preserve native TLS settings shared with the application database provider. */
  ssl: boolean | ConnectionOptions;
}

export interface OwnedLogger {
  logger: Logger;
  close(): Promise<void>;
}

/**
 * Creates a stable logger facade whose destination can change with the
 * application lifecycle. Child facades keep their bindings across switches.
 */
export function createDelegatingLogger(
  getLogger: () => Logger,
): Logger {
  const createFacade = (resolve: () => Logger): Logger => new Proxy(
    {} as Logger,
    {
      get: (_target, property) => {
        if (property === "child") {
          return (...arguments_: Parameters<Logger["child"]>) => {
            let parent: Logger | undefined;
            let child: Logger | undefined;

            return createFacade(() => {
              const activeParent = resolve();

              if (parent !== activeParent || child === undefined) {
                parent = activeParent;
                child = activeParent.child(...arguments_) as unknown as Logger;
              }

              return child as Logger;
            });
          };
        }

        const active = resolve();
        const value = Reflect.get(active, property, active) as unknown;

        return typeof value === "function" ? value.bind(active) : value;
      },
      has: (_target, property) => property in resolve(),
      set: (_target, property, value) => Reflect.set(
        resolve(),
        property,
        value,
      ),
    },
  );

  return createFacade(getLogger);
}

/**
 * Enriches each log call with the latest tagged execution context snapshot.
 *
 * The wrapper also follows derived child loggers so application-owned bindings
 * do not accidentally disable dynamic context propagation.
 */
export function createDynamicExecutionLogger(
  logger: Logger,
  context: ExecutionContext,
  isEnabled: () => boolean = () => true,
): Logger {
  return new Proxy(logger, {
    get: (target, property, receiver) => {
      if (property === "child") {
        return (...arguments_: Parameters<Logger["child"]>) =>
          createDynamicExecutionLogger(
            target.child(...arguments_) as unknown as Logger,
            context,
            isEnabled,
          );
      }

      const value = Reflect.get(target, property, receiver) as unknown;

      if (
        typeof property !== "string"
        || typeof value !== "function"
        || !Object.hasOwn(target.levels.values, property)
      ) {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...arguments_: unknown[]) => {
        if (!isEnabled()) {
          Reflect.apply(value, target, arguments_);
          return;
        }

        const fields = projectExecutionLogContext(context);

        if (Object.keys(fields).length === 0) {
          Reflect.apply(value, target, arguments_);
          return;
        }

        Reflect.apply(
          value,
          target,
          addExecutionContext(arguments_, fields),
        );
      };
    },
  });
}

/** Adds the execution workload as a stable top-level binding once known. */
export function createExecutionWorkloadLogger(
  logger: Logger,
  context: ExecutionContext,
): Logger {
  let activeLogger = logger;
  let activeWorkload: AppWorkload | undefined;

  return createDelegatingLogger(() => {
    const workload = projectExecutionLogContext(context).workload;

    if (workload !== activeWorkload) {
      activeWorkload = workload;
      activeLogger = workload === undefined
        ? logger
        : logger.child({ workload });
    }

    return activeLogger;
  });
}

/** Promotes stable execution metadata and retains only contributed context. */
export function projectExecutionLogContext(
  context: ExecutionContext,
): ExecutionLogContextFields {
  const {
    executionId: _executionId,
    operation,
    transport,
    workload,
    ...additionalContext
  } = context.toRecord(executionContextLogDestination);

  return {
    ...(typeof operation === "string" ? { operation } : {}),
    ...(typeof transport === "string" ? { transport } : {}),
    ...(isAppWorkload(workload) ? { workload } : {}),
    ...(Object.keys(additionalContext).length === 0
      ? {}
      : { executionContext: additionalContext }),
  };
}

/** Keeps arbitrary diagnostic values from becoming unsupported bindings. */
function isAppWorkload(value: unknown): value is AppWorkload {
  return typeof value === "string"
    && appWorkloads.some((workload) => workload === value);
}

/** Preserves Pino's message and error overloads while adding one namespaced field. */
function addExecutionContext(
  arguments_: readonly unknown[],
  fields: ExecutionLogContextFields,
): unknown[] {
  const [first, ...rest] = arguments_;

  if (first instanceof Error) {
    return [{ err: first, ...fields }, ...rest];
  }

  if (typeof first === "object" && first !== null) {
    return [{ ...first, ...fields }, ...rest];
  }

  if (first === null) {
    return [{ ...fields }, ...rest];
  }

  return [{ ...fields }, ...arguments_];
}

/**
 * Creates a standard Pino logger whose destination is managed by Pino. The
 * application owns flushing it but must not close process stdout.
 */
export function createLogger(
  options: LoggerOptions = {},
): OwnedLogger {
  const logger = pino(options);

  return {
    logger,
    close: () => new Promise<void>((resolve, reject) => {
      logger.flush((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    }),
  };
}

/**
 * Creates the local logger and owns the lifecycle of its PostgreSQL transport.
 */
export function createDevLogger(
  databaseConfig: LoggerDatabaseConfig,
  options: LoggerOptions = {},
): OwnedLogger {
  const transport = pino.transport({
    target: resolveTransportTarget(),
    options: {
      host: databaseConfig.host,
      port: databaseConfig.port,
      user: databaseConfig.user,
      password: databaseConfig.password,
      database: databaseConfig.database,
      ssl: databaseConfig.ssl,
    },
  } satisfies TransportSingleOptions);
  // Apply the same filtering policy as standard destinations before transport.
  const logger = pino(options, transport);
  let closed = false;

  // Pino transport errors are not recoverable. Re-throwing prevents local
  // development from continuing while logs are silently discarded.
  transport.on("error", (error: Error) => {
    queueMicrotask(() => {
      throw error;
    });
  });

  return {
    logger,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      transport.end();
      await once(transport, "close");
    },
  };
}

/**
 * Resolves the TypeScript source under tsx and the emitted JavaScript module
 * in production builds without requiring a copied transport asset.
 */
function resolveTransportTarget(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";

  return fileURLToPath(
    new URL(`./postgres_transport.${extension}`, import.meta.url),
  );
}
