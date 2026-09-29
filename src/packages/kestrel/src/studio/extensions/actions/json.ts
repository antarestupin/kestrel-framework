import type { StudioActionJson, StudioActionJsonSchema } from "./contract.js";

/** Reject lossy JSON conversions (class instances, undefined, non-finite numbers and cycles). */
export function isStudioActionJson(
  value: unknown,
  ancestors = new Set<object>(),
): value is StudioActionJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) return false;
    if (Array.isArray(value)) {
      // Reject holes and extra properties that JSON.stringify would silently discard.
      if (keys.length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !isStudioActionJson(descriptor.value, ancestors)
        )
          return false;
      }
      return true;
    }
    // Inspect descriptors so serialization never invokes application getters or toJSON hooks.
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return (
        descriptor.enumerable &&
        "value" in descriptor &&
        isStudioActionJson(descriptor.value, ancestors)
      );
    });
  } finally {
    ancestors.delete(value);
  }
}

/** Generate an editable starting point, never execute schema transforms while documenting. */
export function generateActionExample(
  schema: StudioActionJsonSchema,
  depth = 0,
): StudioActionJson {
  if (typeof schema === "boolean" || depth > 8) return null;
  if (isStudioActionJson(schema.default)) return schema.default;
  if (isStudioActionJson(schema.const)) return schema.const;
  if (Array.isArray(schema.examples) && isStudioActionJson(schema.examples[0]))
    return schema.examples[0];
  if (Array.isArray(schema.enum) && isStudioActionJson(schema.enum[0]))
    return schema.enum[0];
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      return generateActionExample(
        schema[key][0] as StudioActionJsonSchema,
        depth + 1,
      );
    }
  }
  switch (schema.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, child]) => [
          name,
          generateActionExample(child as StudioActionJsonSchema, depth + 1),
        ]),
      );
    case "array":
      return [];
    case "boolean":
      return true;
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "string": {
      const formats: Record<string, string> = {
        email: "user@example.com",
        uuid: "00000000-0000-4000-8000-000000000000",
        date: "2026-01-01",
        "date-time": "2026-01-01T12:00:00.000Z",
        uri: "https://example.com",
      };
      return formats[String(schema.format)] ?? "example";
    }
    default:
      return null;
  }
}
