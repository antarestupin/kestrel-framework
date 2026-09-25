# Errors

[Usage index](./README.md) · [Implementation and handler extensions](../implementation/errors.md)

Use representable errors for expected failures with a stable public meaning. Unexpected failures are rendered by the execution's error handler.

## Return a useful HTTP status and CLI exit code

Give an expected failure a stable representation when callers need to react to it. This conflict error becomes an HTTP 409 or a dedicated CLI exit code through the same business operation.

```ts
import type { CliRepresentableError, HttpRepresentableError } from "@kestrel/framework/errors";

class ResourceConflictError extends Error implements HttpRepresentableError, CliRepresentableError {
  toHttpError() {
    return {
      statusCode: 409,
      message: "The resource already exists.",
      // Expose a stable code clients can use without parsing the message.
      extensions: { code: "resource_exists" },
    };
  }

  toCliError() {
    // Scripts can distinguish this expected conflict from an unexpected failure.
    return { exitCode: 3, message: "The resource already exists." };
  }
}

function ensureAvailable(exists: boolean): void {
  // Throw from an action or controller; the transport renders the representation.
  if (exists) throw new ResourceConflictError();
}
```

An error can implement either interface or both. Public representations must be safe in every environment; do not include secrets or internal diagnostics in their messages or extensions.

## Keep domain errors independent from transports

Use an application error handler when the same domain failure needs different public meanings depending on its context. Centralizing the mapping also keeps reporting policy at the execution boundary.

Leave domain failures as ordinary `Error` subclasses when their public meaning depends on context. Register a scoped handler under `errorHandlerDependency` that extends `DefaultErrorHandler`, overriding `resolveHttp` or `resolveCli` and delegating other errors to `super`. The [handler reference](../implementation/errors.md#execution-handler) describes this extension contract.

Unexpected errors receive an opaque message and execution identifier by default. Debug mode may expose stack and cause details; choose that policy at application composition. Error handling happens before execution-scope disposal, so reporting can still use scoped logging and diagnostics.

## Use cases still to document

- Register a scoped DefaultErrorHandler subclass with contextual HTTP and CLI mappings.
- Report an unexpected failure with its execution identifier and scoped diagnostics.
- Configure debug details at application composition and verify public error responses.
