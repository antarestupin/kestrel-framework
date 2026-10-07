import type { FastifyInstance } from "fastify";

import type { RuntimeApp } from "../app/index.js";
import type { HttpAccessPolicy } from "./access.js";

/** Context supplied when an HTTP runtime mounts a declared extension. */
export interface HttpExtensionContext<Config> {
  readonly app: RuntimeApp<Config>;
  readonly server: FastifyInstance;
  /** Runtime fallback to forward into controller managers owned by extensions. */
  readonly defaultAccess?: HttpAccessPolicy;
}

/** Declares transport setup that is deferred until an HTTP runtime exists. */
export interface HttpExtension<Config> {
  mount(context: HttpExtensionContext<Config>): Promise<void> | void;
}
