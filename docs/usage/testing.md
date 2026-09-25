# Testing

[Usage index](./README.md) · [Implementation and isolated infrastructure helpers](../implementation/testing.md)

Test application behavior through injected dependencies and public execution APIs. Test Kestrel libraries within their own source boundary. Use Vitest and `fastify.inject()` without starting a listening server.

## Test an action with a fake dependency

Test business behavior in isolation when its external dependency can be replaced with a small fake. The action still runs through validation and dependency resolution.

```ts
import { expect, it } from "vitest";
import { z } from "zod";
import { createActionRunner, defineAction } from "@kestrel/framework/actions";
import { createDependencyContainer, dep } from "@kestrel/framework/di";

type Directory = { name(id: string): Promise<string> };
const greet = defineAction({
  name: "greeting.greet", input: z.object({ id: z.string() }), output: z.string(),
  dependencies: { directory: dep<Directory>("directory") },
  handler: async ({ id }, { directory }) => `Hello, ${await directory.name(id)}!`,
});
it("greets the resolved person", async () => {
  const container = createDependencyContainer({});
  // Replace the external service through DI while keeping the real action runner.
  container.registerValue("directory", { name: async () => "Sam" } satisfies Directory);
  try {
    const runner = createActionRunner(container, greet);
    await expect(runner.run({ id: "member-1" })).resolves.toBe("Hello, Sam!");
  } finally {
    await container.dispose();
  }
});
```

Use `App.get` instead when the behavior needs application lifecycle or execution-scoped services. Neither approach needs mocked module imports.

## Exercise an HTTP controller in process

Use an in-process request when a test needs routing and response validation as well as the handler. Fastify injection exercises that boundary without opening a listening socket.

```ts
import Fastify from "fastify";
import { App } from "@kestrel/framework/app";
import { defineHttpAccessPolicy, defineHttpController, get, HttpControllerManager } from "@kestrel/framework/http";

it("serves a validated health response", async () => {
  const app = new App({});
  const server = Fastify();
  const manager = new HttpControllerManager(app, server);
  manager.register(defineHttpController({
    route: get("/health"), access: defineHttpAccessPolicy("test.public"),
    output: z.object({ status: z.literal("ok") }),
    handler: () => ({ status: "ok" as const }),
  }));
  try {
    await app.start();
    // Exercise routing and serialization without starting a listening server.
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  } finally {
    try { await server.close(); } finally { await app.dispose(); }
  }
});
```

Use `CliCommandManager` with injected output writers for command tests. Inject `fetch` for outbound HTTP, memory adapters for storage-neutral behavior, and explicit clocks for time-dependent units.

## Run focused checks

Run a targeted test file or library while iterating on a change. Use the type checker separately to validate TypeScript contracts across the project.

```sh
# Run the relevant tests with concise output.
npm run test:ai -- packages/kestrel/src/actions
# Check types across the project independently of test execution.
npm run typecheck
```

For the snippets above, save the module as `src/example.test.ts` and target that file. Keep tests compatible with `--no-isolate`: restore global state, listeners and timers, and close all owned resources. Do not unit test configuration-only declarations.

PostgreSQL and Redis adapter tests need isolated real stores. The [infrastructure helper reference](../implementation/testing.md#public-api) documents `createPostgresTestPool` and `createRedisTestContext`, connection settings and cleanup. Never share application data or clear an entire shared Redis database for one test.

## Use cases still to document

- Test application lifecycle and execution-scoped resource cleanup.
- Capture CLI output, exit codes and error representations.
- Use isolated PostgreSQL and Redis helpers with deterministic cleanup.
- Test background execution and workflow replay with controlled time and injected dependencies.
