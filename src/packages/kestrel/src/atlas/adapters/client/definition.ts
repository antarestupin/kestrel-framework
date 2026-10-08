import { defineAtlasClientAdapter, type AtlasClientAdapterDefinition } from "../../adapter_definition.js";
import { ViteAtlasClientAdapter, type ViteAtlasClientAdapterOptions } from "./adapter.js";
import type { ViteClientDevelopmentOptions } from "../../../client/adapters/vite/development_runtime.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";

type Settings = Omit<ViteAtlasClientAdapterOptions, "development">;
type Development = ViteClientDevelopmentOptions | RegisteredDependencyDescriptor<ViteClientDevelopmentOptions> | undefined;

/** Packaged delivery has no runtime dependency. Shared development runtimes are borrowed separately. */
export function viteAtlasClient(settings: Settings): AtlasClientAdapterDefinition;
export function viteAtlasClient(development: Development, settings: Settings): AtlasClientAdapterDefinition;
export function viteAtlasClient(first: Settings | Development, second?: Settings): AtlasClientAdapterDefinition {
  const settings = (second === undefined ? first : second) as Settings;
  const development = second === undefined ? undefined : first as Development;
  if (development !== undefined && "kind" in development) {
    return defineAtlasClientAdapter({
      dependencies: { development }, capabilities: {},
      create: ({ development }) => new ViteAtlasClientAdapter({ ...settings, development }),
    });
  }
  return defineAtlasClientAdapter({
    dependencies: {}, capabilities: {},
    create: () => new ViteAtlasClientAdapter({ ...settings, ...(development === undefined ? {} : { development }) }),
  });
}
