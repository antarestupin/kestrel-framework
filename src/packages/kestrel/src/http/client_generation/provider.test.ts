import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../../app/index.js";
import { CliCommandManager } from "../../cli/index.js";
import type { CatalogTree } from "../../utils/index.js";
import { defineHttpController } from "../controller.js";
import { get } from "../route.js";
import { testHttpAccess } from "../../testing/http_access.js";
import { httpClientGenerationConfigSchema, type HttpClientGenerationConfig } from "./configuration.js";
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
  catalogExportName: "adminCatalog",
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
  it("registers a minimal operational CLI controller", async () => {
    const app = new App({});
    const provider = new RecordingHttpClientGenerationProvider(
      config,
      catalog,
    );

    try {
      app.register(provider);

      expect(app.catalog.cliControllers.definitions).toEqual([
        expect.objectContaining({
          command: "generate http-clients",
          description: "Generate the configured TypeScript HTTP clients.",
          observe: false,
          runningMode: "minimal",
          workloads: [],
        }),
      ]);
      expect(app.catalog.cliControllers.registrations[0]?.source).toEqual({
        kind: "provider", provider: RecordingHttpClientGenerationProvider.name,
      });
    } finally {
      await app.dispose();
    }
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
        catalogExportName: "adminCatalog",
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
    { selection: { factoryName: "0createClient" }, error: "factory name must be a TypeScript identifier" },
    { selection: { factoryName: "createClient!" }, error: "factory name must be a TypeScript identifier" },
  ])("rejects invalid generators before any writes: $selection", async ({ selection, error }) => {
    const provider = new RecordingHttpClientGenerationProvider({
      ...config,
      // A valid first client must not be written if a later selection is invalid.
      generators: [appGenerator, { ...adminGenerator, ...selection }],
    }, catalog);

    await expect(provider.generate()).rejects.toThrow(error);
    expect(provider.writes).toHaveLength(0);
  });

  it("preserves valid configurations and rejects empty audience and generator lists", () => {
    expect(httpClientGenerationConfigSchema.parse(config)).toEqual(config);
    expect(httpClientGenerationConfigSchema.safeParse({ ...config, generators: [] }).success).toBe(false);
    expect(httpClientGenerationConfigSchema.safeParse({
      ...config, audiences: { audiences: [], defaultAudiences: [] },
    }).success).toBe(false);
  });

  it("runs the registered CLI command and writes the configured client files", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kestrel-http-generation-"));
    const app = new App({});
    const output: string[] = [];
    const errors: string[] = [];
    const manager = new CliCommandManager(app, {
      writeOutput: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    });
    const appFile = join(folder, "app.ts");
    const adminFile = join(folder, "admin.ts");
    try {
      app.register(new HttpClientGenerationProvider({
        ...config,
        generators: [
          { ...appGenerator, outputFile: appFile },
          { ...adminGenerator, outputFile: adminFile },
        ],
      }, catalog));
      for (const controller of app.catalog.cliControllers.definitions) manager.register(controller);

      // The real command goes through its output schema and the provider's default writer.
      expect(await manager.run(["generate", "http-clients", "--_format", "json"])).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(output.join(""))).toEqual({
        clients: [
          { outputFile: appFile, status: "generated" },
          { outputFile: adminFile, status: "generated" },
        ],
      });
      await expect(readFile(appFile, "utf8")).resolves.toContain("export function createAppClient");
      await expect(readFile(adminFile, "utf8")).resolves.toContain('import type { adminCatalog }');
      await expect(readFile(appFile, "utf8")).resolves.toContain('import type { applicationHttpControllerCatalog }');

      output.length = 0;
      expect(await manager.run(["generate", "http-clients", "--_format", "json"])).toBe(0);
      expect(JSON.parse(output.join(""))).toEqual({
        clients: [
          { outputFile: appFile, status: "unchanged" },
          { outputFile: adminFile, status: "unchanged" },
        ],
      });
      expect(errors).toEqual([]);
    } finally {
      await app.dispose();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each([appGenerator.outputFile, "/generated/nested/../app.ts"])(
    "rejects duplicate output paths before writing clients (%s)", async (outputFile) => {
      const duplicateOutputProvider = new RecordingHttpClientGenerationProvider({
        ...config,
        generators: [appGenerator, { ...adminGenerator, outputFile }],
      }, catalog);

      await expect(duplicateOutputProvider.generate()).rejects.toThrow(
        "Duplicate generated HTTP client output file: /generated/app.ts",
      );
      expect(duplicateOutputProvider.writes).toHaveLength(0);
    },
  );
});
