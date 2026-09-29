import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import type { CatalogTree } from "../../utils/index.js";
import { defineHttpController } from "../controller.js";
import { get } from "../route.js";
import { testHttpAccess } from "../../testing/http_access.js";
import { defineHttpControllerAudiences } from "./audience.js";
import { filterHttpControllerCatalog } from "./catalog.js";

const controllerAudiences = defineHttpControllerAudiences({
  audiences: ["app", "admin"],
  defaultAudiences: ["app"],
});
const defaultController = defineHttpController({
  access: testHttpAccess,
  route: get("/spaces/:id"),
  output: z.null(),
  handler: () => null,
});
const adminController = defineHttpController({
  access: testHttpAccess,
  route: get("/admin/spaces/:id"),
  audiences: ["admin"],
  output: z.null(),
  handler: () => null,
});
const sharedController = defineHttpController({
  access: testHttpAccess,
  route: get("/spaces/:id/history"),
  audiences: ["app", "admin"],
  output: z.null(),
  handler: () => null,
});

const catalog = {
  administration: {
    space: adminController,
  },
  debate: {
    space: {
      get: defaultController,
      history: sharedController,
    },
  },
} satisfies CatalogTree<typeof defaultController>;

describe("HTTP controller audience filtering", () => {
  it("applies defaults and removes non-matching branches", () => {
    const filteredCatalog = filterHttpControllerCatalog(
      catalog,
      controllerAudiences,
      ["app"],
    );

    expect(filteredCatalog).toEqual({
      debate: {
        space: {
          get: defaultController,
          history: sharedController,
        },
      },
    });
    // Filtering creates a new tree without mutating the source.
    expect(catalog.administration.space).toBe(adminController);
  });

  it("includes explicit and shared controllers for matching audiences", () => {
    const filteredCatalog = filterHttpControllerCatalog(
      catalog,
      controllerAudiences,
      ["admin"],
    );

    expect(filteredCatalog).toEqual({
      administration: {
        space: adminController,
      },
      debate: {
        space: {
          history: sharedController,
        },
      },
    });
  });

  it.each([
    { audiences: [], error: "filter audience list cannot be empty" },
    { audiences: ["unknown"], error: "Unknown HTTP controller audience: unknown" },
    { audiences: ["app", "app"], error: "Duplicate HTTP controller filter audience: app" },
    { audiences: [" "], error: "filter audience name cannot be empty" },
  ])("rejects invalid audience filters: $audiences", ({ audiences, error }) => {
    expect(() => filterHttpControllerCatalog(
      catalog,
      controllerAudiences,
      audiences,
    )).toThrow(error);
  });

  it("rejects unknown controller audiences", () => {
    const unknownController = defineHttpController({
      access: testHttpAccess,
      route: get("/unknown"),
      audiences: ["unknown"],
      handler: () => undefined,
    });

    expect(() => filterHttpControllerCatalog(
      { unknown: unknownController },
      controllerAudiences,
      ["app"],
    )).toThrow("Unknown HTTP controller audience: unknown");
  });

  it("rejects duplicate generated identities", () => {
    const firstController = defineHttpController({
      access: testHttpAccess,
      route: get("/first"),
      operationId: "duplicate.read",
      handler: () => undefined,
    });
    const secondController = defineHttpController({
      access: testHttpAccess,
      route: get("/second"),
      operationId: "duplicate.read",
      handler: () => undefined,
    });
    const directController = defineHttpController({
      access: testHttpAccess,
      route: get("/direct"),
      operationId: "direct.read",
      handler: () => undefined,
    });
    const nestedController = defineHttpController({
      access: testHttpAccess,
      route: get("/nested"),
      operationId: "nested.read",
      handler: () => undefined,
    });

    expect(() => filterHttpControllerCatalog({
      first: firstController,
      second: secondController,
    }, controllerAudiences, ["app"])).toThrow(
      "Duplicate HTTP operation identifier duplicate.read",
    );
    expect(() => filterHttpControllerCatalog({
      "space.get": directController,
      space: {
        get: nestedController,
      },
    }, controllerAudiences, ["app"])).toThrow(
      "Conflicting HTTP controller catalog path: space.get",
    );
  });
});
