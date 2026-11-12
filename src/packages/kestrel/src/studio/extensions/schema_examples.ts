type JsonSchema = boolean | Record<string, unknown>;

/** Generate a deterministic editor example from the documented input schema. */
export function generateExampleValue(schema: JsonSchema): unknown {
  if (typeof schema === "boolean") {
    return schema ? "example" : undefined;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
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
      return generateExampleValue(alternatives[0] as JsonSchema);
    }
  }

  switch (schema.type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "array": {
      // Draft 2020-12 describes each tuple position independently.
      if (Array.isArray(schema.prefixItems)) {
        return schema.prefixItems.map((item) => generateExampleValue(item as JsonSchema));
      }
      if (schema.maxItems === 0 || schema.items === false) {
        return [];
      }
      const itemSchema = Array.isArray(schema.items)
        ? schema.items[0]
        : schema.items;

      return itemSchema === undefined
        ? []
        : [generateExampleValue(itemSchema as JsonSchema)];
    }
    case "object": {
      const properties = isRecord(schema.properties)
        ? schema.properties
        : {};

      return Object.fromEntries(Object.entries(properties).map(
        ([name, propertySchema]) => [
          name,
          generateExampleValue(propertySchema as JsonSchema),
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
