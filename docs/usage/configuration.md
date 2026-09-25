# Configuration

[Usage index](./README.md) · [Implementation and source resolution](../implementation/configuration.md)

Resolve configuration once at the application boundary. Pass each provider its resolved section; actions and services receive values through dependency injection.

## Configure a library and select deployment values

Resolve library settings at application startup when deployments need different values. This example combines cache defaults, an explicit environment variable and a deployment-specific debug flag.

```ts
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { cacheConfigBase } from "@kestrel/framework/cache";

const configuration = createConfigurationApi({
  environments: ["development", "test", "production"],
  defaultEnvironment: "development",
  environmentOverrides: { prefix: "APP_CONFIG" },
});
const { defineConfig, envVar, fromEnv } = configuration;
const definition = defineConfig({
  cache: configure(cacheConfigBase, {
    namespace: "example",
    // The library schema validates the raw variable and supplies its default.
    defaultTtlSeconds: envVar("CACHE_TTL_SECONDS"),
  }),
  features: defineConfig({
    // Select application behavior from the resolved deployment environment.
    debug: fromEnv({ development: true, test: true, default: false }),
  }),
});

export const config = configuration.resolveConfig(definition, {
  environment: configuration.resolveEnvironment(process.env.ENVIRONMENT),
  env: process.env,
});
export type AppConfig = typeof config;
```

Only the application boundary reads `process.env`. Kestrel libraries receive abstract settings such as `debug`, `enabled` or `devMode`; they do not know application environment names. A missing variable preserves the library schema's default; required values fail with their configuration path.

## Override a library setting without another binding

Use conventional overrides when a deployment needs to adjust a supported library setting without changing application code. With the prefix above, configuration can set a schema leaf:

```sh
# Override a supported library schema leaf through the configured prefix.
APP_CONFIG__CACHE__MAX_ENTRIES=20000
# This setting uses the explicit envVar binding declared above.
CACHE_TTL_SECONDS=120
```

Explicit bindings are authoritative: setting both `CACHE_TTL_SECONDS` and `APP_CONFIG__CACHE__DEFAULT_TTL_SECONDS` fails. Unknown conventional paths also fail. Conventional overrides cover library schema leaves, not arbitrary application fields, arrays or polymorphic objects.

## Add an application setting with validation

Add a validated application field when a setting does not belong to a library. Here, startup must reject a support address that is missing or is not a valid email address.

```ts
import { z } from "zod";

const applicationDefinition = defineConfig({
  ...definition,
  // Validate the deployment value while resolving configuration at startup.
  supportAddress: envVar("SUPPORT_ADDRESS", z.email()),
});
// Resolve this assembled definition instead of the earlier one when using it.
```

Split larger definitions into focused factories receiving the same specialized configuration API. Composition uses normal object construction, with no implicit deep merge. Custom configuration bases and future source types belong in the [implementation reference](../implementation/configuration.md#library-configuration-bases).

## Use cases still to document

- Split configuration into typed factories sharing one configuration API.
- Combine environment selections, fallbacks and explicit variable bindings.
- Diagnose missing values, validation errors and conflicting overrides from concrete examples.
