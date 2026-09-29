import type { HttpRoute } from "./route.js";

export interface HttpBodyBinding {
  readonly kind: "body";
  readonly name?: string;
}

export interface HttpPathBinding {
  readonly kind: "path";
  readonly name?: string;
}

export interface HttpQueryBinding {
  readonly kind: "query";
  readonly name?: string;
}

export type HttpInputBinding =
  | HttpBodyBinding
  | HttpPathBinding
  | HttpQueryBinding;

/**
 * Binds an input field to a request body property.
 */
export function body(name?: string): HttpBodyBinding {
  return createBinding("body", name);
}

/**
 * Binds an input field to a route path parameter.
 */
export function path(name?: string): HttpPathBinding {
  return createBinding("path", name);
}

/**
 * Binds an input field to a query string parameter.
 */
export function query(name?: string): HttpQueryBinding {
  return createBinding("query", name);
}

/**
 * Resolves the effective transport binding used for one controller input.
 * Keeping this convention public lets introspection tools mirror request
 * handling without maintaining a second implementation of the rules.
 */
export function resolveHttpInputBinding(
  route: HttpRoute,
  field: string,
  binding?: HttpInputBinding,
): HttpInputBinding {
  if (binding !== undefined) {
    return binding;
  }

  if (extractHttpPathParameters(route.url).has(field)) {
    return { kind: "path" };
  }

  return {
    kind: route.method === "GET" ? "query" : "body",
  };
}

/** Extracts Fastify-style named parameters from an HTTP route URL. */
export function extractHttpPathParameters(url: string): ReadonlySet<string> {
  return new Set(
    [...url.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
}

function createBinding<Kind extends HttpInputBinding["kind"]>(
  kind: Kind,
  name?: string,
): Extract<HttpInputBinding, { kind: Kind }> {
  if (name !== undefined && name.trim().length === 0) {
    throw new TypeError("An HTTP binding name cannot be empty.");
  }

  return (
    name === undefined
      ? { kind }
      : { kind, name }
  ) as Extract<HttpInputBinding, { kind: Kind }>;
}
