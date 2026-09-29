import { dep } from "../di/index.js";
import type { Cache, TagAwareCache } from "./types.js";

/** Application-owned cache shared by every transport. */
export const cacheDependency = dep<Cache>("cache");


/** Requires tag support and fails during resolution for incompatible backends. */
export const tagAwareCacheDependency = dep<TagAwareCache>("tagAwareCache");
