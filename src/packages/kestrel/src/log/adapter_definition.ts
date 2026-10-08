import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { LoggerConfig } from "./configuration.js";
import type { OwnedLogger } from "./logger.js";
import type { ProviderBootApp } from "../app/index.js";
export interface LoggerAdapterContext {
  readonly config: LoggerConfig;
  readonly bootPlan: ProviderBootApp<unknown>["bootPlan"];
}
export type LoggerAdapterDefinition = AdapterDefinition<
  OwnedLogger,
  LoggerAdapterContext,
  Readonly<Record<never, never>>
>;
/** Defines a logger destination while keeping execution logging policy in its provider. */
export function defineLoggerAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends OwnedLogger,
>(
  options: AdapterFactoryOptions<
    Value,
    LoggerAdapterContext,
    Readonly<Record<never, never>>,
    Dependencies
  >,
): LoggerAdapterDefinition {
  return defineAdapter(options);
}
