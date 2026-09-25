import { Buffer } from "node:buffer";

export interface SerializedCacheValue {
  sizeBytes: number;
  value: unknown;
}

/**
 * Applies JSON serialization before storage so every adapter exposes the same
 * value semantics and size accounting.
 */
export function serializeCacheValue(
  value: unknown,
): SerializedCacheValue {
  if (value === undefined) {
    throw new TypeError("Cache values cannot be undefined.");
  }

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Cache values must be JSON serializable.", {
      cause: error,
    });
  }

  if (serialized === undefined) {
    throw new TypeError("Cache values must be JSON serializable.");
  }

  return {
    sizeBytes: getUtf8Size(serialized),
    value: JSON.parse(serialized) as unknown,
  };
}

/** Returns the encoded byte size used for logical cache capacity accounting. */
export function getUtf8Size(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
