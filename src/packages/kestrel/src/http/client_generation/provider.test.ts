import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../../app/index.js";
import type { CatalogTree } from "../../utils/index.js";
import { defineHttpController } from "../controller.js";
import { get } from "../route.js";
import { testHttpAccess } from "../../testing/http_access.js";
import type { HttpClientGenerationConfig } from "./configuration.js";
import type { WriteHttpClientOptions } from "./generator.js";
import {
  HttpClientGenerationProvider,
  type HttpClientGenerationResult,
} from "./provider.js";

const controller = defineHttpController({
  access: testHttpAccess,
  route: get("/health"),
  operationId: "app.health",
  handler: () => undefined,
});
const catalog = {
  app: { health: controller },
} satisfies CatalogTree<typeof controller>;
const appGenerator = {
  name: "app",
  audiences: ["app"],
  factoryName: "createAppClient",
  outputFile: "/generated/app.ts",
  catalogImportPath: "./catalog.js",
  runtimeImportPath: "./client.js",
};
const adminGenerator = {
  name: "admin",
  audiences: ["app", "admin"],
  factoryName: "createAdminClient",
  outputFile: "/generated/admin.ts",
  catalogImportPath: "./catalog.js",
  runtimeImportPath: "./client.js",
};
const config = {
  audiences: {
    audiences: ["app", "admin"],
    defaultAudiences: ["app", "admin"],
  },
  generators: [
    appGenerator,
    adminGenerator,
  ],
} satisfies HttpClientGenerationConfig;

class RecordingHttpClientGenerationProvider
  extends HttpClientGenerationProvider<{}> {
  public readonly writes: WriteHttpClientOptions[] = [];

  public generate(): Promise<HttpClientGenerationResult> {
    return this.generateClients();
  }

  protected override writeClient(
    options: WriteHttpClientOptions,
  ): Promise<boolean> {
    this.writes.push(options);

    // Exercise both statuses exposed by the CLI result.
    return Promise.resolve(options.name === "app");
  }
}

describe("HTTP client generation provider", () => {
  it("registers a minimal operational CLI controller", () => {
    const app = new App({});
    const provider = new RecordingHttpClientGenerationProvider(
      config,
      catalog,
    );

    app.register(provider);

    expect(app.catalog.cliControllers.definitions).toEqual([
      expect.objectContaining({
        command: "generate http-clients",
        observe: false,
        runningMode: "minimal",
        workloads: [],
      }),
    ]);
  });

  it("passes configured audiences and reports generated files", async () => {
    const provider = new RecordingHttpClientGenerationProvider(
      config,
      catalog,
    );

    await expect(provider.generate()).resolves.toEqual({
      clients: [
        { outputFile: "/generated/app.ts", status: "generated" },
        { outputFile: "/generated/admin.ts", status: "unchanged" },
      ],
    });
    expect(provider.writes).toEqual([
      expect.objectContaining({ name: "app", audiences: ["app"] }),
      expect.objectContaining({
        name: "admin",
        audiences: ["app", "admin"],
      }),
    ]);
    expect(provider.writes.every(({ controllerAudiences }) =>
      controllerAudiences === config.audiences)).toBe(true);
    expect(provider.writes.every(({ catalog: value }) => value === catalog))
      .toBe(true);
  });

  it.each([
    { selection: { name: " " }, error: "generator name cannot be empty" },
    { selection: { audiences: [] }, error: "Too small" },
    { selection: { audiences: ["unknown"] }, error: "Unknown HTTP controller audience: unknown" },
    { selection: { audiences: ["app", "app"] }, error: "Duplicate HTTP controller filter audience: app" },
  ])("rejects invalid generators before any writes: $selection", async ({ selection, error }) => {
    const provider = new RecordingHttpClientGenerationProvider({
      ...config,
      // A valid first client must not be written if a later selection is invalid.
      generators: [appGenerator, { ...adminGenerator, ...selection }],
    }, catalog);

    await expect(provider.generate()).rejects.toThrow(error);
    expect(provider.writes).toHaveLength(0);
  });

  it("rejects duplicate output files before writing clients", async () => {
    const duplicateOutputProvider = new RecordingHttpClientGenerationProvider(
      {
        ...config,
        generators: [
          appGenerator,
          {
            ...adminGenerator,
            outputFile: appGenerator.outputFile,
          },
        ],
      },
      catalog,
    );

    await expect(duplicateOutputProvider.generate()).rejects.toThrow(
      "Duplicate generated HTTP client output file: /generated/app.ts",
    );
    expect(duplicateOutputProvider.writes).toHaveLength(0);
  });
});
