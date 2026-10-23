# Dependency injection

[Usage index](./README.md) · [Implementation and lifetimes](../implementation/di.md)

Declare what an action or service needs; register infrastructure in a provider at composition time.

## Inject a service and a configuration value

Declare dependencies when an action needs an application-owned service or setting. The greeting asks for a directory and a prefix, while the provider chooses how to supply the directory.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { App, type Provider, type ProviderCompositionApp } from "@kestreljs/framework/app";
import { createDependencyApi, dep } from "@kestreljs/framework/di";

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

## Inject an action definition

Declare `dependencies: { getUser }` where `getUser` is an action definition. The handler receives a typed runner and calls `await getUser.run({ id })`. No named registration is required: the runner uses the caller's scope and preserves the child action's input validation, output validation and middleware. See the complete [nested action example](./actions.md#inject-another-action).

Libraries can support their own definition types by implementing the DI-owned `ResolvableDependency<Config, Value>` protocol with the exported `resolveDependency` symbol. Business handlers consume the resolved values; container access remains inside the protocol implementation. See the [protocol contract](../implementation/di.md#resolvable-definitions).

## Inject an asynchronously created value

Use `registerAsyncFactory(id, dependencies, factory, options)` when creating a value requires asynchronous work, or when a service needs an asynchronously created dependency. Declare prerequisites explicitly so Kestrel can await the complete graph before constructing a consumer. The existing `dep<Value>(id)` declares the final value, without a `Promise` in its type.

```ts
// Register these factories in a provider during composition.
const profileDependency = dep<{ name: string }>("profile");
app.container.registerAsyncFactory(
  "profile",
  { directory: directoryDependency },
  async ({ directory }) => ({ name: await directory.findName("member-1") }),
  { lifetime: "scoped" },
);
app.container.registerAsyncFactory(
  "greetingText",
  { profile: profileDependency },
  // The profile is already loaded when this synchronous consumer executes.
  ({ profile }) => `Hello, ${profile.name}!`,
  { lifetime: "scoped" },
);
```

An action declaring `dependencies: { greeting: dep<string>("greetingText") }` receives a string directly. Actions, middleware, HTTP and CLI controllers, workers and scheduled tasks await their declared dependencies automatically. Independent prerequisites load concurrently; middleware still executes in declaration order, and handler dependencies resolve after middleware has completed its setup.

At a composition or execution boundary, use `await container.resolveAsync(profileDependency)` or `await container.resolveDependenciesAsync({ profile: profileDependency })`. An `ActionExecution` also exposes `resolveDependenciesAsync()`. The synchronous `resolve()` and `resolveDependencies()` APIs remain available for synchronous graphs; requesting an asynchronous registration through them throws an explanatory error, even after its value has been cached.

For a class that consumes an asynchronous value, register an explicit factory such as `registerAsyncFactory("service", { profile: profileDependency }, ({ profile }) => new ProfileService({ profile }), { lifetime: "scoped" })`. Ordinary `registerFactory()`, `registerClass()` and automatically constructed class declarations keep their synchronous constructor injection; they cannot implicitly await an asynchronous prerequisite. Register asynchronous work with `registerAsyncFactory()` rather than returning a Promise from an ordinary factory.

Scoped and singleton factories share their in-flight operation and final result, including a rejection, for their owning lifetime. Retrying after a scoped failure requires a new scope. Transient factories run separately for each resolution. Singletons resolve against the root container, while scoped factories see the active scope's overrides. A cached factory cannot capture a shorter-lived registration.

Supply `dispose` in the options to release an owned resource. Disposal waits for in-flight factories, releases asynchronous consumers before their prerequisites, then releases synchronous resources. Async transient instances with a disposer are also owned by their resolving scope. A factory that allocates a resource and then rejects must clean up that partial allocation itself, because no value was returned to the container. See the [implementation contract](../implementation/di.md#asynchronous-factories) for failure and lifecycle details.

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
