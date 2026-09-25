import Fastify from "fastify";
import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../app/index.js";
import {
  defineHttpController,
  get,
  HttpControllerManager,
} from "../http/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import type { StudioExtension } from "./extension.js";
import type { SvgIconDefinition } from "./icon_definition.js";
import {
  joinStudioPath,
  Studio,
} from "./studio.js";

const exampleIcon: SvgIconDefinition = {
  type: "svg",
  viewBox: [0, 0, 16, 16],
  paths: [{ d: "M1 1h14v14H1z" }],
};

const exampleExtension: StudioExtension = {
  id: "example",
  title: "Example",
  icon: exampleIcon,
  pages: [
    {
      id: "overview",
      title: "Overview",
      path: "/example",
      kind: "example-page",
      icon: exampleIcon,
      dataPath: "/api/extensions/example",
    },
  ],
  links: [
    {
      id: "external-tool",
      title: "External tool",
      href: "https://example.com/tool",
      icon: exampleIcon,
    },
  ],
  defineHttpControllers({ basePath }) {
    return [
      defineHttpController({
        access: testHttpAccess,
        route: get(joinStudioPath(basePath, "/api/extensions/example")),
        handler: () => ({ value: "example" }),
      }),
    ];
  },
};

describe("Studio", () => {
  it("exposes a client manifest and extension routes under its base path", async () => {
    const server = Fastify();
    const studio = new Studio({
      basePath: "/development",
      extensions: [exampleExtension],
    });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const manifestResponse = await server.inject({
      method: "GET",
      url: "/development/api/manifest",
    });
    const extensionResponse = await server.inject({
      method: "GET",
      url: "/development/api/extensions/example",
    });

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      basePath: "/development",
      icons: { "icon-1": exampleIcon },
      extensions: [
        {
          id: "example",
          title: "Example",
          icon: "icon-1",
          section: {
            id: "example",
            title: "Example",
          },
          pages: [
            {
              id: "overview",
              title: "Overview",
              path: "/example",
              kind: "example-page",
              icon: "icon-1",
              dataPath: "/development/api/extensions/example",
            },
          ],
          links: [
            {
              id: "external-tool",
              title: "External tool",
              href: "https://example.com/tool",
              icon: "icon-1",
            },
          ],
        },
      ],
    });
    expect(extensionResponse.json()).toEqual({ value: "example" });

    await server.close();
    await app.dispose();
  });

  it("normalizes a trailing slash in the configured base path", () => {
    const studio = new Studio({ basePath: "/_tools///" });

    expect(studio.basePath).toBe("/_tools");
  });

  it("keeps hidden pages routable in the client manifest", () => {
    const studio = new Studio({
      extensions: [
        {
          ...exampleExtension,
          pages: [
            ...exampleExtension.pages,
            {
              id: "detail",
              title: "Detail",
              path: "/example/$detailId",
              kind: "example-detail",
              showInNavigation: false,
            },
          ],
        },
      ],
    });

    expect(studio.getManifest().extensions[0]?.pages[1]).toMatchObject({
      path: "/example/$detailId",
      showInNavigation: false,
    });
  });

  it("merges section references by id or title and creates unknown sections", () => {
    const studio = new Studio({
      extensions: [
        {
          ...exampleExtension,
          section: { id: "observability", title: "Observability", order: 30 },
        },
        {
          ...exampleExtension,
          id: "by-id",
          section: "observability",
          pages: [{ ...exampleExtension.pages[0]!, path: "/by-id" }],
        },
        {
          ...exampleExtension,
          id: "by-title",
          section: "Observability",
          pages: [{ ...exampleExtension.pages[0]!, path: "/by-title" }],
        },
        {
          ...exampleExtension,
          id: "new-section",
          section: "Custom tools",
          pages: [{ ...exampleExtension.pages[0]!, path: "/custom" }],
        },
      ],
    });

    expect(studio.getManifest().extensions.map(({ section }) => section))
      .toEqual([
        { id: "observability", title: "Observability", order: 30 },
        { id: "observability", title: "Observability", order: 30 },
        { id: "observability", title: "Observability", order: 30 },
        { id: "custom-tools", title: "Custom tools" },
      ]);
  });

  it("groups default sections that share the same title", () => {
    const studio = new Studio({
      extensions: [
        exampleExtension,
        {
          ...exampleExtension,
          id: "another-example",
          pages: [{ ...exampleExtension.pages[0]!, path: "/another-example" }],
        },
      ],
    });

    expect(studio.getManifest().extensions.map(({ section }) => section))
      .toEqual([
        { id: "example", title: "Example" },
        { id: "example", title: "Example" },
      ]);
  });

  it("rejects extension ids and page paths that cannot be routed safely", () => {
    expect(() => new Studio({
      extensions: [
        { ...exampleExtension, id: "Invalid id" },
      ],
    })).toThrow("must use lowercase kebab-case");

    expect(() => new Studio({
      extensions: [
        {
          ...exampleExtension,
          pages: [
            { ...exampleExtension.pages[0]!, path: "/example/" },
          ],
        },
      ],
    })).toThrow("must use a non-root absolute path");
  });

  it("rejects duplicate extension ids and page paths", () => {
    expect(() => new Studio({
      extensions: [exampleExtension, exampleExtension],
    })).toThrow("registered more than once");

    expect(() => new Studio({
      extensions: [
        exampleExtension,
        {
          ...exampleExtension,
          id: "another-example",
        },
      ],
    })).toThrow('page path "/example" is registered more than once');
  });

  it("rejects unsafe or duplicate external links", () => {
    expect(() => new Studio({
      extensions: [
        {
          ...exampleExtension,
          links: [
            {
              id: "external-tool",
              title: "Unsafe tool",
              href: "javascript:alert('unsafe')",
            },
          ],
        },
      ],
    })).toThrow("must use an absolute HTTP URL without credentials");

    expect(() => new Studio({
      extensions: [
        {
          ...exampleExtension,
          links: [
            ...exampleExtension.links!,
            exampleExtension.links![0]!,
          ],
        },
      ],
    })).toThrow("registered more than once");
  });
});
