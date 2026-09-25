# Dependency injection

[Usage index](./README.md) · [Implementation and lifetimes](../implementation/di.md)

Declare what an action or service needs; register infrastructure in a provider at composition time.

## Inject a service and a configuration value

Declare dependencies when an action needs an application-owned service or setting. The greeting asks for a directory and a prefix, while the provider chooses how to supply the directory.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { App, type Provider, type ProviderCompositionApp } from "@kestrel/framework/app";
import { createDependencyApi, dep } from "@kestrel/framework/di";

type Config = { greeting: { prefix: string } };
type NameDirectory = { findName(id: string): Promise<string> };
// The token name matches the registration supplied by DirectoryProvider.
const directoryDependency = dep<NameDirectory>("nameDirectory");
const { fromConfig } = createDependencyApi<Config>();

const greet = defineAction({
  name: "greeting.lookup",
  input: z.object({ id: z.string() }),
  output: z.string(),
  dependencies: {
    directory: directoryDependency,
    // Read a typed configuration value without passing App into business code.
    prefix: fromConfig((config) => config.greeting.prefix),
  },
  handler: async ({ id }, { directory, prefix }) =>
    `${prefix}, ${await directory.findName(id)}!`,
});

class DirectoryProvider implements Provider<Config> {
  register(app: ProviderCompositionApp<Config>): void {
    // A real integration can register a client factory with a disposer here.
    app.container.registerValue("nameDirectory", {
      findName: async (id: string) => `User ${id}`,
    } satisfies NameDirectory);
  }
}
const app = new App({ greeting: { prefix: "Hello" } })
  .register(new DirectoryProvider());
```

Run `greet` through the application as in [Actions](./actions.md). Concrete constructible classes may also be declared directly in `dependencies`. A named dependency is useful for an interface or a client whose construction belongs to a provider.

## Own a resource's lifetime

Choose a lifetime when a dependency holds state or needs cleanup. A scoped scratch buffer belongs to one execution and is cleared when that scope is disposed.

```ts
class ResourceProvider implements Provider<Config> {
  register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory("scratchBuffer", () => new Map<string, string>(), {
      lifetime: "scoped",
      // The execution scope releases only the instances it actually created.
      dispose: (buffer) => buffer.clear(),
    });
  }
}
```

Choose `singleton` for an application-wide client, `scoped` for per-execution state, or `transient` for a new instance on each resolution. Constructors use named registrations for their injected properties. Keep direct container access in composition and execution boundaries; business code consumes declared dependencies.

For standalone tests, create a container with `createDependencyContainer(config)` and dispose it after use; see [testing](./testing.md).

## Use cases still to document

- Inject a concrete class and its own named dependencies.
- Register an application-wide client factory with initialization and disposal.
- Resolve singleton, scoped and transient dependencies across two isolated executions.
