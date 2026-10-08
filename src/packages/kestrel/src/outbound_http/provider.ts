import type {
  Provider,
  ProviderCompositionApp,
} from "../app/index.js";
import { observerContextDependency } from "../observability/index.js";
import { outboundHttpConfigBase, type OutboundHttpConfig } from "./configuration.js";
import { OutboundHttpClient } from "./client.js";
import {
  recordOutboundHttpInstrumentation,
  type OutboundHttpInstrumentation,
} from "./observations.js";
import type {
  OutboundHttpClientFactory,
} from "./types.js";

/** Registers a singleton factory with automatic execution observations. */
export class OutboundHttpProvider<Config> implements Provider<Config> {
  private readonly defaults: OutboundHttpConfig;

  /** Validate and snapshot defaults once; each client may override individual budgets. */
  public constructor(config: Partial<OutboundHttpConfig> = {}) {
    this.defaults = outboundHttpConfigBase.schema.parse(config);
  }

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "outboundHttpClientFactory",
      () => this.createFactory(app),
      { lifetime: "singleton" },
    );
  }

  /** Creates clients without coupling the standalone core to application DI. */
  protected createFactory(
    app: ProviderCompositionApp<Config>,
  ): OutboundHttpClientFactory {
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    const ambientInstrumentation: OutboundHttpInstrumentation | undefined =
      observerContext === undefined
        ? undefined
        : {
            record: (event) => {
              const observer = observerContext.get();

              if (observer !== undefined) {
                recordOutboundHttpInstrumentation(observer, event);
              }
            },
          };

    return {
      create: (options) => {
        const instrumentation = combineInstrumentation(
          ambientInstrumentation,
          options.instrumentation,
        );

        const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs;
        return new OutboundHttpClient({
          ...options,
          // Undefined inherits; overriding one budget must retain the others.
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          maxResponseBytes: options.maxResponseBytes ?? this.defaults.maxResponseBytes,
          maxErrorBodyBytes: options.maxErrorBodyBytes ?? this.defaults.maxErrorBodyBytes,
          ...(instrumentation === undefined ? {} : { instrumentation }),
        });
      },
    };
  }
}

function combineInstrumentation(
  first: OutboundHttpInstrumentation | undefined,
  second: OutboundHttpInstrumentation | undefined,
): OutboundHttpInstrumentation | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;

  return {
    record: (event) => {
      try {
        first.record(event);
      } catch {
        // One diagnostic sink cannot suppress another one.
      }

      try {
        second.record(event);
      } catch {
        // Instrumentation failures never alter HTTP request semantics.
      }
    },
  };
}
