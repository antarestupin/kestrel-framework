import type {
  OutboundHttpJsonSchema,
  OutboundHttpResponseDecoder,
} from "./types.js";

/** Decodes and validates a JSON response with an application-owned schema. */
export function json<Output>(
  schema: OutboundHttpJsonSchema<Output>,
): OutboundHttpResponseDecoder<Output> {
  return {
    description: "JSON",
    decode: async (response) => schema.parseAsync(await response.json()),
  };
}

/** Returns a response body as text. */
export function text(): OutboundHttpResponseDecoder<string> {
  return {
    description: "text",
    decode: (response) => response.text(),
  };
}

/** Returns a response body as bytes. */
export function bytes(): OutboundHttpResponseDecoder<Uint8Array<ArrayBuffer>> {
  return {
    description: "binary",
    decode: async (response) => new Uint8Array(await response.arrayBuffer()),
  };
}

/** Preserves the native response for callers that need streaming access. */
export function nativeResponse(): OutboundHttpResponseDecoder<Response> {
  return {
    description: "native",
    lifetime: "stream",
    decode: async (response) => response,
  };
}
