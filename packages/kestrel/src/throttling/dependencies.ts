import { dep } from "../di/index.js";
import type { Throttling } from "./types.js";

/** Application-owned throttling facade shared by every transport. */
export const throttlingDependency = dep<Throttling>("throttling");
