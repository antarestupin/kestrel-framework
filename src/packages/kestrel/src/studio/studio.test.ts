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

  it("serves a metadata-only extension at the root mount", async () => {
    const extension: StudioExtension = {
      id: "resources",
      title: "Resources",
      description: "Development references.",
      pages: [{ id: "guide", title: "Guide", path: "/guide", kind: "guide" }],
      links: [{ id: "manual", title: "Manual", href: "https://example.com/manual" }],
    };
    const studio = new Studio({ basePath: "/", extensions: [extension] });
    const manifest = studio.getManifest();

    expect(studio.getManifest()).toBe(manifest);
    expect(manifest).toEqual({
      basePath: "/",
      icons: {},
      extensions: [{ ...extension, section: { id: "resources", title: "Resources" } }],
    });

    const server = Fastify();
    const app = new App({});
    try {
      const manager = new HttpControllerManager(app, server);
      for (const controller of await studio.defineHttpControllers()) {
        manager.register(controller);
      }
      await app.start();

      const response = await server.inject("/api/manifest");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(manifest);
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it.each(["///", "//other.test", "/\\other.test", "/\t/other.test", "/tools/%2e%2e"])(
    "rejects a mount path which a browser would reinterpret (%j)",
    (basePath) => {
      expect(() => new Studio({ basePath })).toThrow(/Studio base path/);
    },
  );

  it.each(["path", "dataPath"] as const)("rejects navigation from a browser-normalized %s", (field) => {
    for (const unsafe of ["/\\other.test", "/\t/other.test", "/safe/../elsewhere"] as const) {
      const extension = {
        ...exampleExtension,
        pages: [{ ...exampleExtension.pages[0]!, [field]: unsafe }],
      };
      expect(() => new Studio({ extensions: [extension] })).toThrow(/Studio page/);
    }
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

  it("merges navigation order regardless of installation order", () => {
    const extensions: StudioExtension[] = [
      { id: "tools", title: "Local tools", pages: [] },
      { id: "unordered", title: "First", pages: [], section: { id: "tools", title: " Tools " } },
      { id: "ordered", title: "Second", pages: [], section: { id: "tools", title: "Tools", order: 7 } },
      { id: "support", title: "Support", pages: [], section: "developer-support" },
    ];

    for (const ordering of [extensions, [...extensions].reverse()]) {
      const studio = new Studio({ extensions: ordering });
      expect(Object.fromEntries(studio.getManifest().extensions.map(({ id, section }) => [id, section])))
        .toEqual({
          tools: { id: "tools", title: "Tools", order: 7 },
          unordered: { id: "tools", title: "Tools", order: 7 },
          ordered: { id: "tools", title: "Tools", order: 7 },
          support: { id: "developer-support", title: "Developer Support" },
        });
    }
  });

  it.each([
    [{ id: "tools", title: "Other", order: 1 }, /has conflicting definitions/],
    [{ id: "tools", title: "Tools", order: 2 }, /has conflicting definitions/],
    [{ id: "other", title: " tools " }, /is used by more than one id/],
    [{ id: "other", title: " " }, /must have a title/],
    [{ id: "other", title: "Other", order: Infinity }, /must be a finite number/],
    [" ", /reference cannot be empty/],
  ] as const)("rejects invalid navigation section %j", (section, error) => {
    expect(() => new Studio({
      extensions: [
        { id: "first", title: "First", pages: [], section: { id: "tools", title: "Tools", order: 1 } },
        { id: "second", title: "Second", pages: [], section },
      ],
    })).toThrow(error);
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

    expect(() => new Studio({
      extensions: [{
        ...exampleExtension,
        pages: [...exampleExtension.pages, { ...exampleExtension.pages[0]!, path: "/other" }],
      }],
    })).toThrow('page id "example.overview" is registered more than once');
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

  it.each([
    ["/manual", /must use an absolute HTTP URL/],
    ["https://reader@example.com", /without credentials/],
    ["https://:password@example.com", /without credentials/],
  ] as const)("rejects an unusable external link %s", (href, error) => {
    expect(() => new Studio({
      extensions: [{
        ...exampleExtension,
        links: [{ ...exampleExtension.links![0]!, href }],
      }],
    })).toThrow(error);
  });
});
