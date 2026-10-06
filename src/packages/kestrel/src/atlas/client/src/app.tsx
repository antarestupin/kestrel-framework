import { useMemo } from "react";

import type { AtlasManifest } from "../../contract.js";
import type { AtlasClientAuthenticationConfig } from "../../client_config.js";
import { createAtlasRouter } from "./router.js";
import {
  AtlasRendererRegistryProvider,
  type AtlasPageRenderers,
  type AtlasRendererRegistries,
  type AtlasViewRenderer,
} from "./renderer_registry.js";
import { AtlasEffectProvider } from "./effects.js";
import { AtlasConfirmationProvider } from "./confirmation.js";

export interface AtlasApplicationProperties {
  readonly authentication?: AtlasClientAuthenticationConfig | undefined;
  readonly manifest: AtlasManifest;
  readonly registries?: AtlasRendererRegistries;
  /** @deprecated Use `registries.views`. */
  readonly viewRenderers?: Readonly<Record<string, AtlasViewRenderer>>;
  /** @deprecated Use `registries.pages`. */
  readonly pageRenderers?: Partial<AtlasPageRenderers>;
}

/** Lightweight application template with application-local renderer registries. */
export function AtlasApplication({
  authentication,
  manifest,
  pageRenderers,
  registries,
  viewRenderers,
}: AtlasApplicationProperties) {
  const resolvedRegistries = useMemo<AtlasRendererRegistries>(() => ({
    ...registries,
    pages: {
      ...registries?.pages,
      ...pageRenderers,
    },
    views: {
      ...registries?.views,
      ...viewRenderers,
    },
  }), [pageRenderers, registries, viewRenderers]);
  const application = useMemo(
    () => createAtlasRouter(
      manifest,
      { authentication, registries: resolvedRegistries },
    ),
    [authentication, manifest, resolvedRegistries],
  );

  return (
    <AtlasConfirmationProvider>
      <AtlasEffectProvider manifest={manifest}>
        <AtlasRendererRegistryProvider registries={resolvedRegistries}>
          <application.RouterProvider router={application.router} />
        </AtlasRendererRegistryProvider>
      </AtlasEffectProvider>
    </AtlasConfirmationProvider>
  );
}
