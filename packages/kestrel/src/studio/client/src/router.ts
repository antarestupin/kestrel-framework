import { createElement } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import type { StudioManifest } from "../../extension.js";
import { loadStudioPageRenderer } from "./extensions.js";
import {
  NotFoundPage,
  StudioHome,
  StudioLayout,
  StudioPage,
} from "./router-view.js";

/**
 * Builds a code-based route tree from server-registered Studio extensions.
 *
 * This module deliberately stays separate from the React component module so
 * Fast Refresh only evaluates consistently exported React components.
 */
export function createStudioRouter(manifest: StudioManifest) {
  const rootRoute = createRootRoute({
    component: () => createElement(StudioLayout, { manifest }),
    notFoundComponent: NotFoundPage,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => createElement(StudioHome, { manifest }),
  });
  const extensionRoutes = manifest.extensions.flatMap((extension) =>
    extension.pages.map((page) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: page.path,
        // Intent preloading fetches only the extension needed by this page.
        loader: () => loadStudioPageRenderer(page.kind),
        component: () => createElement(StudioPage, { page }),
      })));
  const routeTree = rootRoute.addChildren([
    indexRoute,
    ...extensionRoutes,
  ]);
  const router = createRouter({
    routeTree,
    basepath: manifest.basePath,
    defaultPreload: "intent",
  });

  return { RouterProvider, router };
}
