import { WorkerPayloadSerializationError } from "./errors.js";

/** Applies native JSON conversions and detaches values from their owner. */
export function serializeWorkerPayload(value: unknown): { value: unknown; bytes: number } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("The root value has no JSON representation.");
    }
    return { value: JSON.parse(serialized) as unknown, bytes: Buffer.byteLength(serialized, "utf8") };
  } catch (cause) {
    throw new WorkerPayloadSerializationError({ cause });
  }
}
