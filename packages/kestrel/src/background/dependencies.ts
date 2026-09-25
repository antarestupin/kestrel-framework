import { dep } from "../di/index.js";
import type { BackgroundRuntime } from "./runtime.js";

export const backgroundRuntimeDependency =
  dep<BackgroundRuntime<any>>("backgroundRuntime");
