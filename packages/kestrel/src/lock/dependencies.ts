import { dep } from "../di/index.js";
import type { Locks } from "./types.js";

/** Application-owned lock manager shared by every transport. */
export const locksDependency = dep<Locks>("locks");
