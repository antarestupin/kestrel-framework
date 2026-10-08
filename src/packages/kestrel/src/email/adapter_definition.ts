import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { EmailTransportAdapter } from "./types.js";
import type { EmailCaptureStorageAdapter } from "./capture.js";
import type { EmailConfig } from "./configuration.js";

type Capabilities = Readonly<Record<never, never>>;
/** Capture persistence is independent of message delivery. */
export type EmailCaptureStorageAdapterDefinition = AdapterDefinition<
  EmailCaptureStorageAdapter,
  undefined,
  Capabilities
>;
export type EmailTransportAdapterDefinition = AdapterDefinition<
  EmailTransportAdapter,
  EmailConfig,
  Capabilities
> & {
  readonly captureStorage?: EmailCaptureStorageAdapterDefinition;
};

/** Defines delivery without a closed registry of transport names. */
export function defineEmailTransportAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends EmailTransportAdapter,
>(
  options: AdapterFactoryOptions<Value, EmailConfig, Capabilities, Dependencies>,
): EmailTransportAdapterDefinition {
  return defineAdapter(options);
}

/** Defines independently owned capture storage. */
export function defineEmailCaptureStorageAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends EmailCaptureStorageAdapter,
>(
  options: AdapterFactoryOptions<Value, undefined, Capabilities, Dependencies>,
): EmailCaptureStorageAdapterDefinition {
  return defineAdapter(options);
}
