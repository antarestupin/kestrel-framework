import { definition as faGlobe } from "@fortawesome/free-solid-svg-icons/faGlobe";
import { z, type ZodType } from "zod";

import {
  defineHttpController,
  extractHttpPathParameters,
  get,
  resolveHttpInputBinding,
} from "../../../http/index.js";
import {
  type AnyHttpController,
  type CatalogTree,
  isHttpController,
} from "../../../utils/index.js";
import type { StudioExtension } from "../../extension.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import { DEV_OBSERVATIONS_DATA_PATH } from "../observability/contract.js";
import {
  CONTROLLERS_STUDIO_EXTENSION_ID,
  CONTROLLERS_STUDIO_PAGE_KIND,
  type StudioHttpControllerCatalog,
  type StudioHttpControllerCatalogNode,
  type StudioHttpControllerDefinition,
  type StudioHttpControllerExample,
  type StudioHttpControllerInput,
  type StudioJsonSchema,
} from "./contract.js";

const controllersIcon = fontAwesomeIcon(faGlobe);

export interface ControllersStudioExtensionOptions {
  /** Enables response-linked observation timelines with this header name. */
  executionIdHeader?: string;
}

/** Adds an interactive explorer for an explicit HTTP controller catalog. */
export function defineControllersStudioExtension(
  catalog: CatalogTree<AnyHttpController>,
  options: ControllersStudioExtensionOptions = {},
): StudioExtension {
  const documentedNodes = documentCatalog(catalog);
  const dataPath = "/api/extensions/controllers" as const;

  return {
    id: CONTROLLERS_STUDIO_EXTENSION_ID,
    title: "Controllers",
    icon: controllersIcon,
    description: "Browse and execute the application's HTTP controllers.",
    section: { id: "app", title: "App", order: 20 },
    pages: [{
      id: "explorer",
      title: "HTTP Controllers",
      path: "/http-controllers",
      description: "Inspect routes and send requests with reusable examples.",
      kind: CONTROLLERS_STUDIO_PAGE_KIND,
      icon: controllersIcon,
      dataPath,
      order: 20,
    }],
    defineHttpControllers({ basePath }) {
      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(joinStudioPath(basePath, dataPath)),
          description: "List HTTP controllers documented by Studio.",
          handler: (): StudioHttpControllerCatalog => ({
            nodes: documentedNodes,
            ...(options.executionIdHeader === undefined
              ? {}
              : {
                  observability: {
                    dataPath: joinStudioPath(
                      basePath,
                      DEV_OBSERVATIONS_DATA_PATH,
                    ),
                    executionIdHeader: options.executionIdHeader,
                  },
                }),
          }),
        }),
      ];
    },
  };
}

function documentCatalog(
  catalog: CatalogTree<AnyHttpController>,
  parentId = "",
): readonly StudioHttpControllerCatalogNode[] {
  return Object.entries(catalog).map(([name, value]) => {
    const id = parentId === "" ? name : `${parentId}.${name}`;

    if (isHttpController(value)) {
      return documentController(id, name, value);
    }

    return {
      kind: "group",
      id,
      name,
      children: documentCatalog(value, id),
    };
  });
}

function documentController(
  id: string,
  name: string,
  controller: AnyHttpController,
): StudioHttpControllerDefinition {
  const requiredFields = getRequiredFields(controller.inputSchema);
  const inputs = Object.entries(controller.inputSchema.shape).map(
    ([field, schema]): StudioHttpControllerInput => {
      const binding = resolveHttpInputBinding(
        controller.route,
        field,
        controller.bindings[field],
      );

      return {
        name: field,
        sourceName: binding.name ?? field,
        binding: binding.kind,
        required: requiredFields.has(field),
        schema: toJsonSchema(schema as ZodType),
      };
    },
  );

  // A handler can consume an undeclared path parameter directly from Fastify.
  // It still needs an editor field so Studio can produce a usable URL.
  for (const pathParameter of extractHttpPathParameters(controller.route.url)) {
    if (!inputs.some((input) =>
      input.binding === "path" && input.sourceName === pathParameter)) {
      inputs.push({
        name: pathParameter,
        sourceName: pathParameter,
        binding: "path",
        required: true,
        schema: { type: "string" },
      });
    }
  }

  return {
    kind: "controller",
    id,
    name,
    method: controller.route.method,
    url: controller.route.url,
    // Catalog definitions remain reusable across runtimes with different defaults.
    access: controller.access?.name ?? "Inherited from HTTP runtime",
    ...(controller.description === undefined
      ? {}
      : { description: controller.description }),
    inputs,
    examples: documentExamples(controller, inputs),
  };
}

function documentExamples(
  controller: AnyHttpController,
  inputs: readonly StudioHttpControllerInput[],
): readonly StudioHttpControllerExample[] {
  if (controller.examples !== undefined && controller.examples.length > 0) {
    return controller.examples.map((example, index) => ({
      name: example.name ?? `Example ${index + 1}`,
      input: example.input as Record<string, unknown>,
    }));
  }

  if (inputs.length === 0) {
    return [];
  }

  return [{
    name: "Generated example",
    input: Object.fromEntries(inputs.map((input) => [
      input.name,
      generateExampleValue(input.schema),
    ])),
  }];
}

function getRequiredFields(schema: ZodType): ReadonlySet<string> {
  const jsonSchema = toJsonSchema(schema);

  if (typeof jsonSchema === "boolean" || !Array.isArray(jsonSchema.required)) {
    return new Set();
  }

  return new Set(
    jsonSchema.required.filter((field): field is string =>
      typeof field === "string"),
  );
}

function toJsonSchema(schema: ZodType): StudioJsonSchema {
  try {
    return z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    });
  } catch {
    // Introspection must remain available when one custom schema cannot be
    // represented as JSON Schema.
    return {};
  }
}

function generateExampleValue(schema: StudioJsonSchema): unknown {
  if (typeof schema === "boolean") {
    return schema ? "example" : undefined;
  }

  if (schema.examples !== undefined && Array.isArray(schema.examples)) {
    return schema.examples[0];
  }

  if (schema.default !== undefined) {
    return schema.default;
  }

  if (schema.const !== undefined) {
    return schema.const;
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum[0];
  }

  for (const alternativeKey of ["oneOf", "anyOf"] as const) {
    const alternatives = schema[alternativeKey];

    if (Array.isArray(alternatives) && alternatives.length > 0) {
      return generateExampleValue(alternatives[0] as StudioJsonSchema);
    }
  }

  switch (schema.type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "array": {
      const itemSchema = Array.isArray(schema.items)
        ? schema.items[0]
        : schema.items;

      return itemSchema === undefined
        ? []
        : [generateExampleValue(itemSchema as StudioJsonSchema)];
    }
    case "object": {
      const properties = isRecord(schema.properties)
        ? schema.properties
        : {};

      return Object.fromEntries(Object.entries(properties).map(
        ([name, propertySchema]) => [
          name,
          generateExampleValue(propertySchema as StudioJsonSchema),
        ],
      ));
    }
    case "null":
      return null;
    case "string":
    default:
      return generateStringExample(schema.format);
  }
}

function generateStringExample(format: unknown): string {
  switch (format) {
    case "date":
      return "2026-01-01";
    case "date-time":
      return "2026-01-01T12:00:00.000Z";
    case "email":
      return "user@example.com";
    case "hostname":
      return "example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    default:
      return "example";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
