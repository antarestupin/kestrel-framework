import { dep } from "../di/index.js";
import type { HttpRuntime } from "./runtime.js";

/** Long-running HTTP transport prepared by the HTTP runtime provider. */
export const httpRuntimeDependency = dep<HttpRuntime<any>>("httpRuntime");
