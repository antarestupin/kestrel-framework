import {
  defineAdapter,
  type AdapterDependencies,
  type AdapterFactoryOptions,
  type AdapterDefinition,
} from "../di/adapter.js";
import type { ScheduledTaskAdapter } from "./types.js";
import type { ScheduledTasksConfig } from "./configuration.js";

/** Public backend recipe shared by built-in and third-party integrations. */
export type ScheduledTaskAdapterDefinition = AdapterDefinition<
  ScheduledTaskAdapter,
  ScheduledTasksConfig,
  Readonly<Record<never, never>>
>;

/** Declares dependencies without opening resources during application composition. */
export function defineScheduledTaskAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends ScheduledTaskAdapter,
>(
  options: AdapterFactoryOptions<
    Value,
    ScheduledTasksConfig,
    Readonly<Record<never, never>>,
    Dependencies
  >,
): ScheduledTaskAdapterDefinition {
  return defineAdapter(options);
}
