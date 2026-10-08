import { defineWebClientAdapter, type WebClientAdapterDefinition } from "../../adapter_definition.js";
import { ViteClientAdapter, type ViteClientAdapterOptions } from "./adapter.js";
import type { ViteClientDevelopmentOptions } from "../../adapters/vite/development_runtime.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";

type Settings = Omit<ViteClientAdapterOptions, "development">;
type Development = ViteClientDevelopmentOptions | RegisteredDependencyDescriptor<ViteClientDevelopmentOptions> | undefined;

/** Packaged delivery has no runtime dependency. Shared development runtimes are borrowed separately. */
export function viteClient(settings: Settings): WebClientAdapterDefinition;
export function viteClient(development: Development, settings: Settings): WebClientAdapterDefinition;
export function viteClient(first: Settings | Development, second?: Settings): WebClientAdapterDefinition {
  const settings = (second === undefined ? first : second) as Settings;
  const development = second === undefined ? undefined : first as Development;
  if (development !== undefined && "kind" in development) {
    return defineWebClientAdapter({
      dependencies: { development }, capabilities: {},
      create: ({ development }) => new ViteClientAdapter({ ...settings, development }),
    });
  }
  return defineWebClientAdapter({
    dependencies: {}, capabilities: {},
    create: () => new ViteClientAdapter({ ...settings, ...(development === undefined ? {} : { development }) }),
  });
}
