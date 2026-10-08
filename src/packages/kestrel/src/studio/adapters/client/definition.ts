import { defineStudioClientAdapter, type StudioClientAdapterDefinition } from "../../adapter_definition.js";
import { ViteStudioClientAdapter, type ViteStudioClientAdapterOptions } from "./adapter.js";
import type { ViteClientDevelopmentOptions } from "../../../client/adapters/vite/development_runtime.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";

type Settings = Omit<ViteStudioClientAdapterOptions, "development">;
type Development = ViteClientDevelopmentOptions | RegisteredDependencyDescriptor<ViteClientDevelopmentOptions> | undefined;

/** Packaged delivery has no runtime dependency. Shared development runtimes are borrowed separately. */
export function viteStudioClient(settings: Settings): StudioClientAdapterDefinition;
export function viteStudioClient(development: Development, settings: Settings): StudioClientAdapterDefinition;
export function viteStudioClient(first: Settings | Development, second?: Settings): StudioClientAdapterDefinition {
  const settings = (second === undefined ? first : second) as Settings;
  const development = second === undefined ? undefined : first as Development;
  if (development !== undefined && "kind" in development) {
    return defineStudioClientAdapter({
      dependencies: { development }, capabilities: {},
      create: ({ development }) => new ViteStudioClientAdapter({ ...settings, development }),
    });
  }
  return defineStudioClientAdapter({
    dependencies: {}, capabilities: {},
    create: () => new ViteStudioClientAdapter({ ...settings, ...(development === undefined ? {} : { development }) }),
  });
}
