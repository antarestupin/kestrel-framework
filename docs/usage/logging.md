# Logging

[Usage index](./README.md) · [Implementation and backend lifecycle](../implementation/logging.md)

The implemented logging library exposes a Pino logger through scoped dependencies. Configure it once, then inject it into actions and services.

## Configure and write structured logs

Inject a logger when an action needs operational messages tied to its execution. Configure the level at application startup and log bounded fields that help explain what happened.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { loggerConfigBase, loggerDependency, LoggerProvider, pinoLogger } from "@kestreljs/framework/log";

const configuration = createConfigurationApi({ environments: ["production"], defaultEnvironment: "production" });
const config = configuration.resolveConfig({ logger: configure(loggerConfigBase, { level: "info" }) }, {
  environment: "production", env: {},
});
const app = new App(config).register(new LoggerProvider(config.logger, pinoLogger()));
const greet = defineAction({
  name: "greeting.greet", input: z.object({ name: z.string() }), output: z.string(),
  dependencies: { logger: loggerDependency },
  handler: ({ name }, { logger }) => {
    // Prefer bounded operational fields over unrestricted request payloads.
    logger.info({ greetingLength: name.length }, "Preparing greeting");
    return `Hello, ${name}!`;
  },
});
```

Run the action through the composed application. Its scoped logger carries the execution identity. Use `applicationLoggerDependency` only for application-owned work outside an execution. The provider owns logger shutdown.

## Add context to the execution summary

Add diagnostics when the final execution log should summarize a business outcome, such as the number of imported records. The action contributes data to the existing summary.

```ts
import { executionContextDependency } from "@kestreljs/framework/app";

const summarize = defineAction({
  name: "import.summarize", input: z.object({ imported: z.number() }), output: z.void(),
  dependencies: { context: executionContextDependency },
  handler: ({ imported }, { context }) => {
    // Attach the count to execution diagnostics for the configured log context mode.
    context.setDiagnostic("imported", imported);
  },
});
```

`executionLog.contextMode: "completion"` emits a summary after execution; `"dynamic"` adds the current context to each scoped log instead. `executionLog.enabled: false` disables automatic execution logging. A scoped `setExecutionLogEnabledDependency(false)` suppresses it for one execution without suppressing explicit handler logs or observations.

Diagnostic values must be JSON-compatible, bounded and safe for their selected destinations. They are not a place for passwords, bearer tokens or unrestricted personal data.

For PostgreSQL development storage and Studio log browsing, pass `postgresLogger(connectionDependency, databaseSettings)` directly to `LoggerProvider` and install the disposable log table; see [development storage](../implementation/logging.md#development-storage). The [native logger plan](../implementation/native_logging_plan.md) describes a proposed replacement, not the current API.

## Use cases still to document

- Wire PostgreSQL development log storage to Studio.
- Select completion or dynamic context and suppress automatic logs for one execution.
- Use an application logger outside execution scopes and own standalone logger cleanup.

## Explicit provider adapters

`LoggerProvider(config, adapter)` accepts `pinoLogger()`, `postgresLogger(connection, settings)` or `defineLoggerAdapter(...)`. The facade remains Pino-compatible. The finalized boot plan is passed to the definition, allowing minimal mode to avoid development storage. Disposal occurs during final container teardown so feature shutdown can still log.

See the [shared composition convention](../implementation/app.md#provider-adapter-convention) and [configuration recipes](../usage/configuration.md#additional-provider-composition).

The PostgreSQL logger accepts the database provider's boolean or native TLS object in `ssl`, including a private CA or client certificate. Pino sends these options to a worker thread, so use structured-clone-compatible TLS values (for example PEM strings); function-valued TLS hooks and native secure-context objects cannot cross that boundary. The transport still owns a separate pool and does not inherit the database provider's resource policy.
