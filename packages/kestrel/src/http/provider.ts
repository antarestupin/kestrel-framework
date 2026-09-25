import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { defineCliController } from "../cli/index.js";
import type { HttpConfig } from "./configuration.js";
import { httpRuntimeDependency } from "./dependencies.js";
import {
  HttpRuntime,
  type HttpRuntimeOptions,
} from "./runtime.js";

/** Declares the HTTP runtime and its operational CLI command. */
export class HttpRuntimeProvider<Config> implements Provider<Config> {
  public constructor(
    private readonly config: HttpConfig,
    private readonly options: HttpRuntimeOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "httpRuntime",
      () => new HttpRuntime(app.runtime, this.config, this.options),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({
      http: {
        controllers: {
          cli: {
            runServer: defineCliController({
              command: "run server",
              description: "Run the HTTP server.",
              dependencies: { runtime: httpRuntimeDependency },
              runtime: "server",
              workloads: ["http"],
              observe: false,
              handler: async ({ deps }) => {
                await deps.runtime.run();
              },
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });
  }
}
