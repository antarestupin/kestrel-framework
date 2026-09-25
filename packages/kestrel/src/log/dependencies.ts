import { dep } from "../di/index.js";
import type { Logger } from "pino";

/** Root logger shared by application transports and infrastructure. */
export const applicationLoggerDependency = dep<Logger>(
  "applicationLogger",
);

/** Execution-scoped child logger intended for actions and services. */
export const loggerDependency = dep<Logger>("logger");

/** Changes execution-log emission for the active dependency scope. */
export type SetExecutionLogEnabled = (enabled: boolean) => void;

/** Execution-scoped control used by technical transports and middleware. */
export const setExecutionLogEnabledDependency =
  dep<SetExecutionLogEnabled>("setExecutionLogEnabled");
