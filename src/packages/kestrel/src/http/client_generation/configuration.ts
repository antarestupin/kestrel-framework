import { z } from "zod";

const audienceNameSchema = z.string().min(1);
const modulePathSchema = z.string().min(1);

/** Declarative contract for one generated TypeScript HTTP client. */
export const httpClientGeneratorConfigSchema = z.object({
  name: z.string().refine((name) => name.trim().length > 0, {
    message: "The HTTP client generator name cannot be empty.",
  }),
  audiences: z.array(audienceNameSchema).min(1),
  factoryName: z.string().regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u,
    "The HTTP client factory name must be a TypeScript identifier.",
  ),
  outputFile: z.string().min(1),
  catalogImportPath: modulePathSchema,
  runtimeImportPath: modulePathSchema,
  catalogExportName: z.string().min(1).optional(),
});

/** Configuration owned by the HTTP client generation provider. */
export const httpClientGenerationConfigSchema = z.object({
  audiences: z.object({
    audiences: z.array(audienceNameSchema).min(1),
    defaultAudiences: z.array(audienceNameSchema),
  }),
  generators: z.array(httpClientGeneratorConfigSchema).min(1),
});

export type HttpClientGeneratorConfig = z.output<
  typeof httpClientGeneratorConfigSchema
>;

export type HttpClientGenerationConfig = z.output<
  typeof httpClientGenerationConfigSchema
>;
