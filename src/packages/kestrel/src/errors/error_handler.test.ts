import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DefaultErrorHandler,
  getHttpErrorName,
  type ErrorRepresentationContext,
  type HttpRepresentableError,
  type CliRepresentableError,
} from "./index.js";

const context: ErrorRepresentationContext = {
  executionId: "execution-123",
};

class PublicError extends Error implements
  HttpRepresentableError,
  CliRepresentableError
{
  public toHttpError() {
    return {
      statusCode: 409,
      message: "The resource already exists.",
      headers: { "retry-after": "10" },
      extensions: { code: "resource_exists" },
    };
  }

  public toCliError() {
    return {
      exitCode: 3,
      message: "The resource already exists.",
    };
  }
}

class ReportingErrorHandler extends DefaultErrorHandler {
  public readonly report = vi.fn();

  protected override reportUnexpected(
    error: unknown,
    transport: "http" | "cli",
    reportContext: ErrorRepresentationContext,
  ): void {
    this.report(error, transport, reportContext);
  }
}

describe("DefaultErrorHandler", () => {
  it("uses transport representations without reporting expected errors", () => {
    const handler = new ReportingErrorHandler({ debug: false });
    const error = new PublicError("Internal conflict details");

    expect(handler.handleHttp(error, context)).toEqual({
      statusCode: 409,
      message: "The resource already exists.",
      headers: { "retry-after": "10" },
      extensions: { code: "resource_exists" },
    });
    expect(handler.handleCli(error, context)).toEqual({
      exitCode: 3,
      message: "The resource already exists.",
    });
    expect(handler.report).not.toHaveBeenCalled();
  });

  it("hides unexpected HTTP error details outside debug mode", () => {
    const handler = new ReportingErrorHandler({ debug: false });
    const error = new Error("Database password leaked");

    expect(handler.handleHttp(error, context)).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
      extensions: { executionId: "execution-123" },
    });
    expect(handler.report).toHaveBeenCalledWith(
      error,
      "http",
      context,
    );
  });

  it("includes the stack and cause chain in HTTP debug responses", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const cause = new TypeError("Database unavailable");
    const error = new Error("Query failed", { cause });
    const representation = handler.handleHttp(error, context);

    expect(representation).toMatchObject({
      statusCode: 500,
      error: "Error",
      message: "Query failed",
      extensions: {
        executionId: "execution-123",
        stack: expect.stringContaining("Error: Query failed"),
        causes: [
          {
            error: "TypeError",
            message: "Database unavailable",
            stack: expect.stringContaining(
              "TypeError: Database unavailable",
            ),
          },
        ],
      },
    });
  });

  it("includes stacks and causes in CLI debug output", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const error = new Error("Query failed", {
      cause: new Error("Connection refused"),
    });

    expect(handler.handleCli(error, context)).toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(
        /Error: Query failed[\s\S]+Caused by: Error: Connection refused/,
      ),
    });
  });

  it("renders an empty aggregate without a stack or a cause list", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const error = new AggregateError([], "No underlying failures");
    delete error.stack;

    expect(handler.handleHttp(error, context)).toStrictEqual({
      statusCode: 500,
      error: "AggregateError",
      message: "No underlying failures",
      extensions: { executionId: "execution-123" },
    });
    expect(handler.handleCli(error, context)).toStrictEqual({
      exitCode: 1,
      message: "AggregateError: No underlying failures",
    });
  });

  it("renders debug diagnostics for thrown values that cannot be stringified", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const unprintable: unknown = Object.create(null);
    const message = "The thrown value could not be converted to a string.";

    expect(handler.handleHttp(unprintable, context)).toStrictEqual({
      statusCode: 500,
      error: "UnknownError",
      message,
      extensions: { executionId: "execution-123" },
    });
    expect(handler.handleCli(unprintable, context)).toStrictEqual({
      exitCode: 1,
      message: `UnknownError: ${message}`,
    });
    expect(handler.handleHttp(new Error("Operation failed", { cause: unprintable }), context).extensions)
      .toMatchObject({ causes: [{ error: "UnknownError", message }] });
  });

  it("retains nested polling failures and avoids duplicate or cyclic diagnostics", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const databaseError = new Error('relation "workflows.task" does not exist');
    const queryError = new Error("Query failed", { cause: databaseError });
    const pollingError = new AggregateError([queryError], "Workflow polling failed.");
    const error = new AggregateError([pollingError, queryError, "Drain failed"], "Runtime failed.");
    // Real supervisors can retain the same failure through multiple owners.
    databaseError.cause = error;

    const cli = handler.handleCli(error, context);
    expect(cli.exitCode).toBe(1);
    expect(cli.message).toContain('relation "workflows.task" does not exist');
    expect(cli.message.match(/Error: Query failed/g)).toHaveLength(1);
    expect(cli.message).toContain("UnknownError: Drain failed");
    expect(handler.handleHttp(error, context).extensions).toMatchObject({
      causes: [
        { message: "Workflow polling failed." },
        { message: "Query failed" },
        { message: databaseError.message },
        { message: "Drain failed" },
      ],
    });
    // Production transport responses must continue hiding internal diagnostics.
    const production = new DefaultErrorHandler({ debug: false });
    expect(production.handleCli(error, context).message).not.toContain(databaseError.message);
    expect(production.handleHttp(error, context).extensions).not.toHaveProperty("causes");
  });
});

describe("getHttpErrorName", () => {
  it("supplies a generic reason phrase for an unrecognized status code", () => {
    expect(getHttpErrorName(409)).toBe("Conflict");
    expect(getHttpErrorName(599)).toBe("Error");
  });
});
