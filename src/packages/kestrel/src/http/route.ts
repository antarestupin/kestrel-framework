export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface HttpRoute {
  readonly method: HttpMethod;
  readonly url: string;
}

/**
 * Defines a GET route independently from Fastify registration.
 */
export function get(url: string): HttpRoute {
  return defineRoute("GET", url);
}

/**
 * Defines a POST route independently from Fastify registration.
 */
export function post(url: string): HttpRoute {
  return defineRoute("POST", url);
}

/**
 * Defines a PATCH route independently from Fastify registration.
 */
export function patch(url: string): HttpRoute {
  return defineRoute("PATCH", url);
}

/**
 * Defines a DELETE route independently from Fastify registration.
 */
export function del(url: string): HttpRoute {
  return defineRoute("DELETE", url);
}

function defineRoute(method: HttpMethod, url: string): HttpRoute {
  if (!url.startsWith("/")) {
    throw new TypeError("An HTTP route URL must start with a slash.");
  }

  return { method, url };
}
