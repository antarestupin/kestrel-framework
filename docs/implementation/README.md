# Understanding and extending Kestrel

[Documentation home](../README.md) · [Using Kestrel](../usage/README.md)

Use these references to understand design choices, implement adapters, extend providers or maintain a library. Each library page links to its concise usage guide. The references retain detailed public contracts, execution scenarios, diagrams, invariants, storage behavior and deferred evolutions.

Some reference pages also preserve historical specifications and illustrative code. Treat explicitly planned sections as proposals; use the usage guides and current source exports for application recipes. Adapter authors should read operation semantics, lifecycle ownership and failure guarantees together before replacing an implementation.

- [Contributing and framework development](../contributing.md)
- [Documentation website internals](./documentation.md) · [Authoring hidden code sections](../contributing.md#focus-code-examples-with-hidden-lines)
- [Distribution and repository boundaries](./distribution.md) · [Usage](../usage/installation.md)

## Compose an application

- [Application](./app.md) · [Usage](../usage/app.md)
- [Configuration](./configuration.md) · [Usage](../usage/configuration.md)
- [Dependency injection](./di.md) · [Usage](../usage/di.md)
- [Definitions and validation](./definitions.md) · [Usage](../usage/definitions.md)
- [Actions](./actions.md) · [Usage](../usage/actions.md)
- [Middleware](./middleware.md) · [Usage](../usage/middleware.md)
- [Errors](./errors.md) · [Usage](../usage/errors.md)

## Expose operations and interfaces

- [Controllers](./controllers.md) · [Usage](../usage/controllers.md)
- [HTTP](./http.md) · [Usage](../usage/http.md)
- [CLI](./cli.md) · [Usage](../usage/cli.md)
- [Browser client delivery](./client.md) · [Usage](../usage/client.md)
- [Studio](./studio.md) · [Usage](../usage/studio.md)

## Store and coordinate data

- [Database](./database.md) · [Usage](../usage/database.md)
- [Pagination](./pagination.md) · [Usage](../usage/pagination.md)
- [Cache](./cache.md) · [Usage](../usage/cache.md)
- [Locks](./lock.md) · [Usage](../usage/lock.md)
- [Throttling](./throttling.md) · [Usage](../usage/throttling.md)

## Authenticate and integrate

- [Authentication](./authentication.md) · [Usage](../usage/authentication.md)
- [Authorization](./authorization.md) · [Usage](../usage/authorization.md)
- [Tokens](./tokens.md) · [Usage](../usage/tokens.md)
- [Email](./email.md) · [Usage](../usage/email.md)
- [Outbound HTTP](./outbound_http.md) · [Usage](../usage/outbound_http.md)

## Run background work

- [Workers](./workers.md) · [Usage](../usage/workers.md)
- [Scheduled tasks](./scheduled_tasks.md) · [Usage](../usage/scheduled_tasks.md)
- [Durable workflows](./workflows.md) · [Usage](../usage/workflows.md)
- [Background runtime](./background.md) · [Usage](../usage/background.md)
- [Events](./events.md) · [Usage](../usage/events.md)
- [Concurrency](./concurrency.md) · [Usage](../usage/concurrency.md)
- [Scheduling primitives](./scheduling.md) · [Usage](../usage/scheduling.md)

## Observe and test

- [Logging](./logging.md) · [Usage](../usage/logging.md)
- [Observability](./observability.md) · [Usage](../usage/observability.md)
- [Testing](./testing.md) · [Usage](../usage/testing.md)
- [Utilities](./utilities.md) · [Usage](../usage/utilities.md)

## Design records and future work

These pages are maintained separately from application recipes. They preserve design rationale and pending decisions rather than promising an available API.

| Record | Status in this checkout |
| --- | --- |
| [Stack](./stack.md) | Technology and tooling context. |
| [Worker specification](./workers_specs.md) | Detailed design and deferred scheduling features. |
| [Workflow specification](./workflows_specs.md) | Design decisions and remaining implementation plan. |
| [Native logging plan](./native_logging_plan.md) | Proposed replacement of the current Pino integration. |
| [Telemetry and Beacon](./monitoring.md) | Target design with historical completion claims; no unified `telemetry` source library is present here. |
| [Beacon](./beacon.md) | Retained design record; no `beacon` source application is present here. |

## Evolving the documentation

Keep observable behavior and runnable application recipes in usage pages. Keep adapter contracts, algorithms, sequence diagrams and future evolutions here. Link both directions when a behavior needs a deeper explanation, and update both indexes when a library is added.

Potential follow-ups are automatic recipe compilation in CI and generated API/configuration reference pages. They should reuse source contracts and preserve these short, curated usage guides rather than expanding every guide into an exhaustive reference.
