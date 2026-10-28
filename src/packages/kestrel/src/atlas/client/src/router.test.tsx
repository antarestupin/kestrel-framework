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

it("does not register create or edit routes for read-only resources", () => {
  const original = manifest.resources[0]!;
  const { list, read, readMany } = original.capabilities;
  const { router } = createAtlasRouter({ ...manifest, resources: [{ ...original, capabilities: { list, read, readMany } }] });
  expect(router.routesByPath["/example/create"]).toBeUndefined();
  expect(router.routesByPath["/example/$recordId/edit"]).toBeUndefined();
  expect(router.routesByPath["/example/$recordId"]).toBeDefined();
});
