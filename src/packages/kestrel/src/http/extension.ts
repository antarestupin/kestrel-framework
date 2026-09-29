import type { FastifyInstance } from "fastify";

import type { RuntimeApp } from "../app/index.js";

/** Context supplied when an HTTP runtime mounts a declared extension. */
export interface HttpExtensionContext<Config> {
  readonly app: RuntimeApp<Config>;
  readonly server: FastifyInstance;
}

/** Declares transport setup that is deferred until an HTTP runtime exists. */
export interface HttpExtension<Config> {
  mount(context: HttpExtensionContext<Config>): Promise<void> | void;
}
