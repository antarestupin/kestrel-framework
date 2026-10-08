import {
  registerAdapter,
  type AdapterDefinition,
  type AdapterRegistration,
} from "../di/adapter.js";
import type { ProviderCompositionApp } from "./app.js";
import { shutdownStartedEvent } from "./events.js";

/** Releases feature adapters while borrowed infrastructure is still alive. */
export function registerProviderAdapter<Config, Value, Context, Capabilities>(
  app: ProviderCompositionApp<Config>,
  id: string,
  definition: AdapterDefinition<Value, Context, Capabilities>,
  context: Context,
  options: { validate?: (value: Value) => void; beforeDispose?: () => void | Promise<void> } = {},
): AdapterRegistration<Value> {
  const registration = registerAdapter(app.container, id, definition, context, options);
  // Container disposal remains a fallback for direct container owners and failed boots.
  app.eventBus.listenAsync(shutdownStartedEvent, () => registration.dispose());
  return registration;
}
