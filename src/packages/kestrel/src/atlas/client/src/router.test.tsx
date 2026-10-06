import { createElement } from "react";
import { describe, expect, it } from "vitest";

import type {
  AtlasManifest,
  AtlasOperationManifest,
} from "../../contract.js";
import { createAtlasRouter } from "./router.js";

const operation: AtlasOperationManifest = {
  id: "example.operation",
  sourceId: "application",
  effect: "read",
  inputs: [],
};
const manifest: AtlasManifest = {
  basePath: "/atlas",
  title: "Atlas",
  defaults: { recordActionsInList: "all" },
  notifications: { position: "bottom-left" },
  icons: {},
  resources: [{
    id: "example",
    label: "Examples",
    labelSingular: "Example",
    identity: "id",
    displayField: "id",
    sourceId: "application",
    fields: [],
    capabilities: {
      list: operation,
      read: operation,
      readMany: operation,
      create: operation,
      update: operation,
      delete: operation,
    },
    views: [{
      id: "summary",
      label: "Summary",
      renderer: "summary",
      query: operation,
    }],
    recordActions: [],
  }],
};

describe("atlas router renderer registries", () => {
  it("uses registered page and View renderers", () => {
    const Home = () => createElement("div", {}, "Custom home");
    const Summary = () => createElement("div", {}, "Custom summary");
    const { router } = createAtlasRouter(manifest, {
      registries: {
        pages: { home: Home },
        views: { summary: Summary },
      },
    });
    const homeComponent = router.routesByPath["/"]?.options.component;
    const viewComponent = router.routesByPath[
      "/example/views/summary"
    ]?.options.component;

    expect(homeComponent?.({} as never)).toEqual(
      expect.objectContaining({ type: Home }),
    );
    expect(viewComponent?.({} as never)).toEqual(
      expect.objectContaining({ type: Summary }),
    );
  });
});
