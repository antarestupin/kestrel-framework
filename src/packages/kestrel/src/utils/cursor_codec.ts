import { Buffer } from "node:buffer";
import { z, type input, type ZodType } from "zod";

export type PaginationCursorCodec<Schema extends ZodType> = z.ZodCodec<z.ZodString, Schema>;

/**
 * Encodes a versioned JSON cursor as an unpadded URL-safe token.
 * The schema's input must be JSON-compatible; use bidirectional Zod codecs
 * for dates or other database values requiring a lossless representation.
 * Encoding provides neither secrecy nor authentication.
 */
export function createPaginationCursorCodec<Schema extends ZodType>(
  schema: Schema,
  options: { maxLength?: number } = {},
): PaginationCursorCodec<Schema> {
  const maxLength = options.maxLength ?? 4096;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new TypeError("The maximum cursor length must be a positive safe integer.");
  }
  const envelope = z.strictObject({ version: z.literal(1), value: z.unknown() });
  return z.codec(z.string().min(1).max(maxLength).regex(/^[A-Za-z0-9_-]+$/u), schema, {
    decode: (token, context) => {
      try {
        const bytes = Buffer.from(token, "base64url");
        // Reject permissive base64 decoding and invalid UTF-8 before JSON parsing.
        if (bytes.toString("base64url") !== token) throw new Error("Noncanonical cursor");
        const decoded = envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (decoded.value == null) throw new Error("Missing cursor value");
        // The codec validates this untrusted value against its output schema next.
        return decoded.value as input<Schema>;
      } catch {
        context.issues.push({ code: "custom", message: "Invalid pagination cursor.", input: token });
        return z.NEVER;
      }
    },
    encode: (value, context) => {
      try {
        if (value == null) throw new Error("Missing cursor value");
        // JSON cannot preserve non-finite numbers, dates, undefined or bigint.
        // Require schemas to encode such values explicitly rather than lose data.
        const snapshot = snapshotJsonCursorValue(value);
        return Buffer.from(JSON.stringify({ version: 1, value: snapshot }), "utf8").toString("base64url");
      } catch {
        context.issues.push({ code: "custom", message: "Cursor values must have a lossless JSON representation.", input: value });
        return z.NEVER;
      }
    },
  });
}

/** Snapshot values during validation so serialization reads the same data. */
function snapshotJsonCursorValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Unsupported JSON cursor value.");

  // JSON.stringify invokes this hook even on arrays and non-enumerable properties.
  if (typeof Reflect.get(value, "toJSON") === "function") {
    throw new TypeError("Cursor values cannot customize JSON serialization.");
  }
  if (Array.isArray(value)) {
    // Match JSON's indexed traversal while rejecting sparse values before growing the snapshot.
    const items: unknown[] = [];
    const { length } = value;
    for (let index = 0; index < length; index += 1) {
      items.push(snapshotJsonCursorValue(value[index]));
    }
    return items;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJsonCursorValue(item)]));
  }
  throw new TypeError("Unsupported JSON cursor value.");
}
