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
  const ApplicationRouter = useMemo(() => {
    const { RouterProvider, router } = createAtlasRouter(
      manifest,
      { authentication, registries: resolvedRegistries },
    );

    // Mount the new router's transition lifecycle when its route closures change.
    return function AtlasRouterInstance() {
      return <RouterProvider router={router} />;
    };
  }, [authentication, manifest, resolvedRegistries]);

  return (
    <AtlasConfirmationProvider>
      <AtlasEffectProvider manifest={manifest}>
        <AtlasRendererRegistryProvider registries={resolvedRegistries}>
          <ApplicationRouter />
        </AtlasRendererRegistryProvider>
      </AtlasEffectProvider>
    </AtlasConfirmationProvider>
  );
}
