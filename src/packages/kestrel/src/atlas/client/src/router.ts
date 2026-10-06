import {
  createElement,
} from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";

import type { AtlasManifest } from "../../contract.js";
import type { AtlasClientAuthenticationConfig } from "../../client_config.js";
import type {
  AtlasPageRenderers,
  AtlasRendererRegistries,
  AtlasViewRenderer,
} from "./renderer_registry.js";
import {
  AtlasLayout,
  NotFoundPage,
} from "./router-view.js";

// Route components remain replaceable while the Kestrel defaults are
// fetched only when navigation first needs their page family.
const AtlasHome = lazyRouteComponent(
  () => import("./home_page.js"),
  "AtlasHome",
);
const ResourceListPage = lazyRouteComponent(
  () => import("./pages.js"),
  "ResourceListPage",
);
const ResourceListViewPage = lazyRouteComponent(
  () => import("./pages.js"),
  "ResourceListViewPage",
);
const ResourceReadPage = lazyRouteComponent(
  () => import("./pages.js"),
  "ResourceReadPage",
);
const ResourceCreatePage = lazyRouteComponent(
  () => import("./pages.js"),
  "ResourceCreatePage",
);
const ResourceEditPage = lazyRouteComponent(
  () => import("./pages.js"),
  "ResourceEditPage",
);
const RecordActionPage = lazyRouteComponent(
  () => import("./pages.js"),
  "RecordActionPage",
);

export interface AtlasRouterOptions {
  readonly authentication?: AtlasClientAuthenticationConfig | undefined;
  readonly registries?: AtlasRendererRegistries;
  /** @deprecated Use `registries.views`. */
  readonly viewRenderers?: Readonly<Record<string, AtlasViewRenderer>>;
  /** @deprecated Use `registries.pages`. */
  readonly pageRenderers?: Partial<AtlasPageRenderers>;
}

const defaultViewRenderers: Readonly<Record<string, AtlasViewRenderer>> = {
  "resource-list": ResourceListViewPage,
};

const defaultPageRenderers: AtlasPageRenderers = {
  layout: AtlasLayout,
  home: AtlasHome,
  resourceList: ResourceListPage,
  resourceRead: ResourceReadPage,
  resourceCreate: ResourceCreatePage,
  resourceEdit: ResourceEditPage,
  recordAction: RecordActionPage,
  notFound: NotFoundPage,
};

/** Builds resource routes from the server-owned manifest. */
export function createAtlasRouter(
  manifest: AtlasManifest,
  options: AtlasRouterOptions = {},
) {
  const viewRenderers = {
    ...defaultViewRenderers,
    ...options.registries?.views,
    ...options.viewRenderers,
  };
  const pageRenderers = {
    ...defaultPageRenderers,
    ...options.registries?.pages,
    ...options.pageRenderers,
  };
  const rootRoute = createRootRoute({
    component: () => createElement(pageRenderers.layout, {
      authentication: options.authentication,
      manifest,
    }),
    notFoundComponent: pageRenderers.notFound,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => createElement(pageRenderers.home, { manifest }),
  });
  const resourceRoutes = manifest.resources.flatMap((resource) => [
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}`,
      component: () => createElement(pageRenderers.resourceList, { manifest, resource }),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}/create`,
      component: () => createElement(pageRenderers.resourceCreate, { manifest, resource }),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}/$recordId`,
      component: () => createElement(pageRenderers.resourceRead, {
        manifest,
        resource,
        recordId: getRecordId(),
      }),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}/$recordId/edit`,
      component: () => createElement(pageRenderers.resourceEdit, {
        manifest,
        resource,
        recordId: getRecordId(),
      }),
    }),
    ...resource.recordActions.map((action) => createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}/$recordId/actions/${action.id}`,
      component: () => createElement(pageRenderers.recordAction, {
        action,
        manifest,
        resource,
        recordId: getRecordId(),
      }),
    })),
    ...resource.views.map((view) => createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource.id}/views/${view.id}`,
      component: () => {
        const Renderer = viewRenderers[view.renderer];

        return Renderer === undefined
          ? createElement("div", { className: "page error-state" },
              `Unknown atlas View renderer: ${view.renderer}`)
          : createElement(Renderer, { manifest, resource, view });
      },
    })),
  ]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, ...resourceRoutes]),
    basepath: manifest.basePath,
    defaultPreload: "intent",
  });

  return { RouterProvider, router };
}

function getRecordId(): string {
  const params = useParams({ strict: false }) as { recordId?: string };

  if (params.recordId === undefined) {
    throw new TypeError("A resource record route requires an identifier.");
  }

  return params.recordId;
}
