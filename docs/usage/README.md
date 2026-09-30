# Using Kestrel

[Documentation home](../README.md) · [Understanding and extending Kestrel](../implementation/README.md)

Start with [application composition](./app.md), then add the libraries needed by your feature. Each guide leads with practical code and keeps architecture, exhaustive contracts and future designs in the implementation reference.

## Reading the examples

Examples use the provisional `@kestreljs/framework` package installed from a local archive. Start with [installation and local development](./installation.md). Unless specified otherwise, application examples live in `src/example.ts`. The consuming application supplies configuration, paths, catalogs, and external services. Memory adapters are process-local and non-durable.

Configuration is resolved before constructing providers. Register infrastructure before its consumers, declare definitions in the application catalog, and select a runtime through the application launcher. Commands using `./do` assume your wrapper already passes the composed application module to the [Kestrel CLI](./cli.md#launch-the-application).

- [Installation and local development](./installation.md)

## Compose an application

| Guide | What you can do |
| --- | --- |
| [Application](./app.md) | Compose providers and catalogs, run actions, own shutdown. |
| [Configuration](./configuration.md) | Resolve library settings and deployment overrides. |
| [Dependency injection](./di.md) | Inject services and choose resource lifetimes. |
| [Definitions and validation](./definitions.md) | Group declarations and select schema parsing modes. |
| [Actions](./actions.md) | Declare, run and derive reusable business operations. |
| [Middleware](./middleware.md) | Surround execution with shared behavior. |
| [Errors](./errors.md) | Represent expected failures across transports. |

## Expose operations and interfaces

| Guide | What you can do |
| --- | --- |
| [Controllers](./controllers.md) | Expose one action through multiple transports. |
| [HTTP](./http.md) | Declare routes, access policies and bindings. |
| [CLI](./cli.md) | Declare commands and launch an application. |
| [Browser client delivery](./client.md) | Mount a Vite client and generate typed HTTP calls. |
| [Studio](./studio.md) | Inspect application definitions and development infrastructure. |

## Store and coordinate data

| Guide | What you can do |
| --- | --- |
| [Database](./database.md) | Install library schemas, generate migrations, configure PostgreSQL, repositories, transactions and history. |
| [Pagination](./pagination.md) | Read numbered pages and encode forward cursors. |
| [Cache](./cache.md) | Load on misses, invalidate tags and choose storage. |
| [Locks](./lock.md) | Acquire finite leases and protect batches of resources. |
| [Throttling](./throttling.md) | Bound requests, cost, concurrency and dependency failures. |

## Authenticate and integrate

| Guide | What you can do |
| --- | --- |
| [Authentication](./authentication.md) | Compose password authentication and sessions. |
| [Authorization](./authorization.md) | Declare permissions and protect operations. |
| [Tokens](./tokens.md) | Issue, consume and revoke typed bearer capabilities. |
| [Email](./email.md) | Send messages or capture them locally. |
| [Outbound HTTP](./outbound_http.md) | Call external APIs with validation, retries and caching. |

## Run background work

| Guide | What you can do |
| --- | --- |
| [Workers](./workers.md) | Publish jobs and handle retryable batches. |
| [Scheduled tasks](./scheduled_tasks.md) | Run recurring maintenance and calendar jobs. |
| [Durable workflows](./workflows.md) | Orchestrate activities, signals and durable waits. |
| [Background runtime](./background.md) | Run schedulers together or independently. |
| [Events](./events.md) | Dispatch scoped in-process notifications. |
| [Concurrency](./concurrency.md) | Buffer batches and drain deferred work. |
| [Scheduling primitives](./scheduling.md) | Own cancellation-aware delays and lease heartbeats. |

## Observe and test

| Guide | What you can do |
| --- | --- |
| [Logging](./logging.md) | Write structured logs and execution summaries. |
| [Observability](./observability.md) | Record typed execution diagnostics. |
| [Testing](./testing.md) | Test actions and controllers without a listening server. |
| [Utilities](./utilities.md) | Generate identifiers, encode cursors and flatten catalogs. |

## Use cases still to document

Each guide ends with a concise list of missing code recipes for supported behavior, including cases currently only mentioned or linked to the implementation reference. These lists track documentation gaps, not planned framework features, and are a starting inventory rather than an exhaustive API audit. Cross-library recipes still to add:

- Assemble a complete application with persistent storage, authenticated HTTP operations and a generated browser client.
- Add a background job to that application and follow its execution through logs and Studio.
