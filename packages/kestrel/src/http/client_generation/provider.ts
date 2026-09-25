import { z } from "zod";

import type { Provider, ProviderCompositionApp } from "../../app/index.js";
import { defineCliController } from "../../cli/index.js";
import type {
  AnyHttpController,
  CatalogTree,
} from "../../utils/index.js";
import {
  defineHttpControllerAudiences,
  validateHttpControllerAudienceFilter,
  type HttpControllerAudienceDefinition,
} from "../audiences/index.js";
import {
  httpClientGeneratorConfigSchema,
  type HttpClientGenerationConfig,
  type HttpClientGeneratorConfig,
} from "./configuration.js";
import {
  writeHttpClient,
  type WriteHttpClientOptions,
} from "./generator.js";

const generationResultSchema = z.object({
  clients: z.array(z.object({
    outputFile: z.string(),
    status: z.enum(["generated", "unchanged"]),
  })),
});

export type HttpClientGenerationResult = z.output<
  typeof generationResultSchema
>;

/** Declares configured HTTP client generation and its CLI command. */
export class HttpClientGenerationProvider<Config>
implements Provider<Config> {
  public constructor(
    protected readonly config: HttpClientGenerationConfig,
    protected readonly catalog: CatalogTree<AnyHttpController>,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.catalog.contribute({
      httpClientGeneration: {
        controllers: {
          cli: {
            generateHttpClients: defineCliController({
              command: "generate http-clients",
              description: "Generate the configured TypeScript HTTP clients.",
              output: generationResultSchema,
              observe: false,
              runningMode: "minimal",
              handler: async () => this.generateClients(),
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });
  }

  /** Generates every configured client after validating their audience selections. */
  protected async generateClients(): Promise<HttpClientGenerationResult> {
    const controllerAudiences = this.createControllerAudiences();
    const options = this.config.generators.map((generator) =>
      this.createGenerationOptions(generator, controllerAudiences));

    validateUniqueOutputFiles(options);

    const clients = await Promise.all(options.map(async (client) => ({
      outputFile: client.outputFile,
      status: await this.writeClient(client)
        ? "generated" as const
        : "unchanged" as const,
    })));

    return { clients };
  }

  /** Builds and validates the application-owned controller audience vocabulary. */
  protected createControllerAudiences(): HttpControllerAudienceDefinition {
    return defineHttpControllerAudiences(this.config.audiences);
  }

  /** Combines one generator with its catalog and shared audience vocabulary. */
  protected createGenerationOptions(
    generator: HttpClientGeneratorConfig,
    controllerAudiences: HttpControllerAudienceDefinition,
  ): WriteHttpClientOptions {
    // Validate every configuration before starting concurrent file writes.
    httpClientGeneratorConfigSchema.parse(generator);
    validateHttpControllerAudienceFilter(
      controllerAudiences,
      generator.audiences,
    );

    return {
      catalog: this.catalog,
      name: generator.name,
      audiences: generator.audiences,
      controllerAudiences,
      factoryName: generator.factoryName,
      catalogImportPath: generator.catalogImportPath,
      runtimeImportPath: generator.runtimeImportPath,
      outputFile: generator.outputFile,
      ...(generator.catalogExportName === undefined
        ? {}
        : { catalogExportName: generator.catalogExportName }),
    };
  }

  /** Writes one generated client; subclasses may replace the output adapter. */
  protected writeClient(options: WriteHttpClientOptions): Promise<boolean> {
    return writeHttpClient(options);
  }
}

/** Prevents concurrent generators from racing on the same output file. */
function validateUniqueOutputFiles(
  clients: readonly WriteHttpClientOptions[],
): void {
  const outputFiles = new Set<string>();

  for (const client of clients) {
    if (outputFiles.has(client.outputFile)) {
      throw new TypeError(
        `Duplicate generated HTTP client output file: ${client.outputFile}.`,
      );
    }

    outputFiles.add(client.outputFile);
  }
}
