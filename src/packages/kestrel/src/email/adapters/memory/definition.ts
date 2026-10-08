import {
  defineEmailTransportAdapter,
  defineEmailCaptureStorageAdapter,
} from "../../adapter_definition.js";
import { MemoryEmailAdapter } from "./adapter.js";
import { MemoryEmailCaptureStorageAdapter } from "./capture_store.js";
/** Creates fresh application-owned in-memory delivery state. */
export function memoryEmail() {
  return defineEmailTransportAdapter({
    dependencies: {},
    capabilities: {},
    create: () => new MemoryEmailAdapter(),
  });
}
/** Creates fresh application-owned capture storage. */
export function memoryEmailCapture() {
  return defineEmailCaptureStorageAdapter({
    dependencies: {},
    capabilities: {},
    create: () => new MemoryEmailCaptureStorageAdapter(),
  });
}
