import { dep } from "../di/index.js";
import type { ScheduledTaskAdapter } from "./types.js";
import type { ScheduledTaskRuntime } from "./runtime.js";

/** Durable occurrence state shared by scheduled-task runtimes and tooling. */
export const scheduledTaskAdapterDependency =
  dep<ScheduledTaskAdapter>("scheduledTaskAdapter");

/** Long-running recurring-task transport prepared by its provider. */
export const scheduledTaskRuntimeDependency =
  dep<ScheduledTaskRuntime<any>>("scheduledTaskRuntime");
