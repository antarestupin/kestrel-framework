# Testing

[Usage index](./README.md) · [Implementation and isolated infrastructure helpers](../implementation/testing.md)

Test application behavior through injected dependencies and public execution APIs. Test Kestrel libraries within their own source boundary. Use Vitest and `fastify.inject()` without starting a listening server.

## Test an action with a fake dependency

Test business behavior in isolation when its external dependency can be replaced with a small fake. The action still runs through validation and dependency resolution.

```ts
import { expect, it } from "vitest";
import { z } from "zod";
import { createActionRunner, defineAction } from "@kestreljs/framework/actions";
import { createDependencyContainer, dep } from "@kestreljs/framework/di";

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
import { App } from "@kestreljs/framework/app";
import { defineHttpAccessPolicy, defineHttpController, get, HttpControllerManager } from "@kestreljs/framework/http";

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
npm run test:ai -- src/packages/kestrel/src/actions
# Check types across the project independently of test execution.
npm run typecheck
```

For the snippets above, save the module as `src/example.test.ts` and target that file. Keep tests compatible with `--no-isolate`: restore global state, listeners and timers, and close all owned resources. Do not unit test configuration-only declarations.

PostgreSQL and Redis adapter tests need isolated real stores. The [infrastructure helper reference](../implementation/testing.md#public-api) documents `createPostgresTestPool` and `createRedisTestContext`, connection settings and cleanup. Never share application data or clear an entire shared Redis database for one test.

<a id="run-the-mutation-testing-pilot"></a>

## Run framework mutation testing

For routine feedback, use the fast profile. It skips pure static mutants and evaluates hybrid mutants only during tests. This reduces assessment coverage; its score is not comparable to the complete profile. It remains a framework-wide run and is not guaranteed to finish quickly.

```sh
npm run test:mutation:fast
npm run test:mutation:fast -- --incremental
# Keep static mutants and assess one existing framework component, including its adapters.
npm run test:mutation:component -- throttling
npm run test:mutation:component -- di --incremental
# Measure nine selected import-time declarations, stopping mutation work after ten minutes.
npm run test:mutation:static-sample -- --incremental --force
```

Component names are top-level directories under `src/packages/kestrel/src`; invalid names fail before provisioning databases. Dependent tests from other components remain eligible through Vitest's import graph. Only the static-sample profile has an automatic ten-minute budget, including its initial instrumented tests. At the deadline the wrapper requests a checkpoint, forcibly stops a stalled Stryker process group after five more seconds, and cleans owned databases. Cleanup can extend beyond the mutation budget. A budget stop exits nonzero with partial results; it does not produce a completed assessment.

Reports and incremental caches are separate: `artifacts/mutation/fast/`, `artifacts/mutation/component-<name>/` and `artifacts/mutation/static-sample/`. The existing full command and its original reports remain unchanged. Use `--incremental --force` after configuration, infrastructure or dependency changes. The static sample also records Stryker events under its `events/` directory for examining baseline timing and individual outcomes. See the [static sample findings](../implementation/mutation_testing_framework.md#bounded-static-sample).

From the repository root, prepare the dedicated PostgreSQL and Redis test infrastructure, then validate the instrumented test run before starting a complete mutation assessment:

```sh
npm run infra:up
npm run infra:prepare
npm run test:mutation:infrastructure
npm run test:mutation:dry-run
npm run test:mutation
```

Stryker mutates TypeScript and TSX runtime code throughout `src/packages/kestrel/src`, including adapters, browser clients, schemas and configuration modules. It excludes tests, declaration files, the repository-only PostgreSQL/Redis test helpers and shared worker conformance test assertions from mutation. The public `testing/http_access.ts` module remains in scope. All framework test files are eligible, including integration tests; application, documentation and generator suites remain outside this command. One non-isolated Vitest project uses the forks pool and snapshots per-file coverage metadata to retain module caching without unbounded metadata accumulation. Normal `npm run test:ai` continues to check full `--no-isolate` compatibility; tests must restore global state and close owned resources.

The npm wrapper gives each Stryker worker a separate temporary PostgreSQL database and cleans only databases recorded for its own run after the processes stop. The configured test role needs database creation/deletion privileges on the dedicated test PostgreSQL service. Connections are guarded against mutated configuration falling back to another destination. Redis tests retain their independent UUID key prefixes on database 2. Always use the npm commands for provisioning and cleanup. `test:mutation:infrastructure` checks routing, lifecycle ownership and the coverage optimization without connecting to PostgreSQL or Redis. Run it after upgrading Stryker or Vitest. A cleanup error reports a retained ownership manifest for recovery; never replace this with a broad prefix-based database deletion.

The dry-run command instruments the complete source scope and executes the unmodified tests without activating individual mutations. It checks that the selected test setup works but does not produce a complete mutation score. For the complete source scope, an absolute CLI entrypoint rerun trigger preserves all 1,633 baseline tests, including subprocess checks whose dependencies are opaque to the import graph. Static mutants then use Vitest's related-suite selection, and runtime mutants additionally use per-test coverage selection. Targeted scopes can select fewer dependent suites and omit graph-opaque subprocess tests; they do not replace a complete assessment. PostgreSQL provisioning applies even to targeted runs; Redis is needed when its integration suites are selected. Missing infrastructure fails rather than silently skipping those suites. See the [infrastructure helper reference](../implementation/testing.md#public-api) for dedicated database connection settings and cleanup.

For local investigation, target a component or file and let Vitest select its dependent framework suites:

```sh
npm run test:mutation -- --mutate src/packages/kestrel/src/utils/cursor_codec.ts
# Reuse unchanged mutation results while iterating locally.
npm run test:mutation -- --incremental
# Refresh the cache after dependencies, configuration or non-mutated helpers change.
npm run test:mutation -- --incremental --force
```

Open `artifacts/mutation/mutation.html` to inspect mutations and their covering tests. The machine-readable report is `artifacts/mutation/mutation.json`. Reports, the incremental cache and Stryker's temporary sandbox are ignored by Git. Targeted fresh runs overwrite the report with the selected scope, so retain a copy before comparing different scopes. A surviving mutant means the selected runtime tests did not detect that change; it does not automatically mean the mutation changes observable behavior.

The default command performs a fresh run. Its score is informational, with no minimum score gate (`thresholds.break: null`); setup and initial test failures still fail the command. Full-framework mutation runs can take substantially longer than the original pilot; use targeted or incremental assessments for local feedback while retaining fresh complete assessments as the reference. The [framework assessment](../implementation/mutation_testing_framework.md) records current findings and priorities. The [pilot analysis](../implementation/mutation_testing_pilot.md) is historical and does not describe the current framework-wide scope or an active score threshold. See the [implementation notes](../implementation/testing.md#framework-mutation-testing) for scope and deferred work.

## Use cases still to document

- Test application lifecycle and execution-scoped resource cleanup.
- Capture CLI output, exit codes and error representations.
- Use isolated PostgreSQL and Redis helpers with deterministic cleanup.
- Test background execution and workflow replay with controlled time and injected dependencies.
