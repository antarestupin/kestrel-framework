# Introduction

Kestrel is a modular application framework for TypeScript and Node.js. It helps you define business operations, expose them through HTTP or CLI, and compose the infrastructure they need in one application.

The central idea is to keep business behavior reusable. An action declares an operation with validated input and output; controllers expose that operation through a transport. The application brings together configuration, dependencies, feature catalogs, and runtime lifecycle.

## Compose your application

Kestrel gives each part of the application an explicit role:

- **Actions** define business operations that can run through HTTP, CLI, background work, or direct calls.
- **Controllers** connect operations to transport-specific input, output, and access policies.
- **Catalogs** group feature definitions so the application and its tools can discover them.
- **Providers** register infrastructure and participate in startup and shutdown.
- **Configuration** supplies the settings chosen by the consuming application.

Start with the modules your application needs, then add capabilities as it grows. Kestrel includes database access, caching, authentication, authorization, background jobs, scheduled tasks, and durable workflows. The usage guides describe each capability's contracts and limitations.

For example, an application can declare a business action once, expose it through an HTTP controller, and call it directly in a test. A generated typed HTTP client connects browser code to the controller contract, while Studio helps inspect registered definitions during development.

## Keep control of execution

Your application owns its configuration, external services, and choice of runtime. Dependency injection connects operations to services, and execution scopes give each invocation a place for scoped dependencies and diagnostics. Application startup and disposal manage the resources registered by providers.

The same composition supports direct action tests and HTTP tests without opening a listening port. See [application composition](./usage/app.md), [dependency injection](./usage/di.md), and [testing](./usage/testing.md) for practical examples.

## Project status

Kestrel is experimental and under active development. APIs and behavior may change without backward compatibility, and it is not ready for production use. The framework and starter are MIT-licensed.

## Get started

Follow [installation and application creation](./usage/installation.md) to install `@kestreljs/framework` in an existing project or generate an application with `@kestreljs/create-kestrel`.

Then read [application composition](./usage/app.md) and [actions](./usage/actions.md) to understand how a feature fits together. Browse the [usage guides](./usage/README.md) for individual capabilities, or the [implementation references](./implementation/README.md) when you need to understand internals or extend the framework.
