import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import type { CatalogTree } from "../../utils/index.js";
import { defineHttpControllerAudiences } from "../audiences/index.js";
import { path, query } from "../bindings.js";
import { defineHttpController } from "../controller.js";
import { get } from "../route.js";
import { testHttpAccess } from "../../testing/http_access.js";
import { generateHttpClientSource } from "./generator.js";

const audiences = defineHttpControllerAudiences({
  audiences: ["app", "admin"],
  defaultAudiences: ["app"],
});

const publicController = defineHttpController({
  access: testHttpAccess,
  route: get("/spaces/:spaceId"),
  operationId: "space.get",
  input: z.object({
    id: z.uuid(),
    projection: z.string().optional(),
  }),
  output: z.object({ id: z.uuid() }),
  bindings: {
    id: path("spaceId"),
    projection: query("fields"),
  },
  handler: ({ input }) => ({ id: input.id }),
});
const adminController = defineHttpController({
  access: testHttpAccess,
  route: get("/admin/spaces"),
  operationId: "space.adminList",
  audiences: ["admin"],
  output: z.array(z.object({ id: z.uuid() })),
  handler: () => [],
});
const emptyController = defineHttpController({
  access: testHttpAccess,
  route: get("/empty"),
  operationId: "empty.read",
  handler: () => undefined,
});
const catalog = {
  debate: {
    space: {
      get: publicController,
    },
  },
  administration: {
    spaces: adminController,
  },
  empty: emptyController,
} satisfies CatalogTree<
  typeof publicController | typeof adminController | typeof emptyController
>;

function generate(name: "app" | "admin"): string {
  return generateHttpClientSource({
    catalog,
    name,
    audiences: [name],
    controllerAudiences: audiences,
    factoryName: name === "app"
      ? "createAppClient"
      : "createAdminClient",
    catalogImportPath: "../../server/core/appCatalog.js",
    runtimeImportPath: "../../kestrel/http/client.js",
  });
}

describe("HTTP client generator", () => {
  it("preserves the filtered hierarchy and controller wire bindings", () => {
    const source = generate("app");

    expect(source).toContain("export function createAppClient");
    expect(source).toContain('"debate": {');
    expect(source).toContain('"space": {');
    expect(source).toContain('"get": (input: AppDebateSpaceGetInput)');
    expect(source).toContain('operationId: "space.get"');
    expect(source).toContain(
      '{"field":"id","kind":"path","name":"spaceId"}',
    );
    expect(source).toContain(
      '{"field":"projection","kind":"query","name":"fields"}',
    );
    expect(source).not.toContain("space.adminList");
  });

  it("generates type-only server links and void undocumented outputs", () => {
    const source = generate("app");

    expect(source).toContain(
      'import type { applicationHttpControllerCatalog } from "../../server/core/appCatalog.js";',
    );
    expect(source).toContain(
      "{@link applicationHttpControllerCatalog.debate.space.get}",
    );
    expect(source).toContain(
      "export type AppEmptyOutput = ControllerOutput<HttpControllerCatalog[\"empty\"]>;",
    );
    expect(source).toContain(
      '"empty": (): Promise<AppEmptyOutput>',
    );
  });

  it("selects administration controllers for a separate client", () => {
    const source = generate("admin");

    expect(source).toContain("export function createAdminClient");
    expect(source).toContain('"administration": {');
    expect(source).toContain("space.adminList");
    expect(source).not.toContain('operationId: "space.get"');
    expect(source).not.toContain('operationId: "empty.read"');
  });

  it("names a client independently from its combined audiences", () => {
    const source = generateHttpClientSource({
      catalog,
      controllerAudiences: audiences,
      name: "combined",
      audiences: ["app", "admin"],
      factoryName: "createCombinedClient",
      catalogImportPath: "./catalog.js",
      runtimeImportPath: "./client.js",
    });

    expect(source).toContain(
      "export type CombinedClient = ReturnType<typeof createCombinedClient>",
    );
    expect(source).toContain("CombinedDebateSpaceGetInput");
    expect(source).toContain('operationId: "space.get"');
    expect(source).toContain('operationId: "space.adminList"');
  });

  it("rejects an empty client name for standalone generation", () => {
    expect(() => generateHttpClientSource({
      catalog,
      controllerAudiences: audiences,
      name: " ",
      audiences: ["app"],
      factoryName: "createAppClient",
      catalogImportPath: "./catalog.js",
      runtimeImportPath: "./client.js",
    })).toThrow("generator name cannot be empty");
  });

  it("rejects catalog paths that collapse to the same generated type name", () => {
    const first = defineHttpController({
      access: testHttpAccess,
      route: get("/first"),
      output: z.string(),
      handler: () => "first",
    });
    const second = defineHttpController({
      access: testHttpAccess,
      route: get("/second"),
      output: z.string(),
      handler: () => "second",
    });

    expect(() => generateHttpClientSource({
      catalog: {
        "space-item": first,
        space_item: second,
      },
      name: "app",
      audiences: ["app"],
      controllerAudiences: audiences,
      factoryName: "createAppClient",
      catalogImportPath: "./catalog.js",
      runtimeImportPath: "./client.js",
    })).toThrow("Conflicting generated HTTP client type name");
  });
});
