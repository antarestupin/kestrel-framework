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
  assertHttpRoutePath(url);
  return { method, url };
}

/** Keeps a route on the current authority when a generated client uses a relative base URL. */
export function assertHttpRoutePath(url: string): void {
  if (!url.startsWith("/")) {
    throw new TypeError("An HTTP route URL must start with a slash.");
  }

  // URL parsers can normalize backslashes and strip control characters.
  if (url[1] === "/" || url[1] === "\\" || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new TypeError("An HTTP route URL must be a path on the current origin.");
  }
}
