import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DefaultErrorHandler,
  getHttpErrorName,
  isCliRepresentableError,
  isHttpRepresentableError,
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

  it("reports the original CLI failure while keeping its public message opaque", () => {
    const handler = new ReportingErrorHandler({ debug: false });
    const error = new Error("Private database connection details");

    expect(handler.handleCli(error, context)).toEqual({
      exitCode: 1,
      message: "An unexpected error occurred. Execution: execution-123",
    });
    expect(handler.report).toHaveBeenCalledExactlyOnceWith(error, "cli", context);
  });

  it("reports the original failure when representation property lookup throws", () => {
    const handler = new ReportingErrorHandler({ debug: false });
    const lookupFailure = new Error("Private property lookup details");
    const original = Object.defineProperties({}, {
      toHttpError: { get() { throw lookupFailure; } },
      toCliError: { get() { throw lookupFailure; } },
    });

    expect(isHttpRepresentableError(original)).toBe(false);
    expect(isCliRepresentableError(original)).toBe(false);
    expect(handler.handleHttp(original, context)).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
      extensions: { executionId: "execution-123" },
    });
    expect(handler.handleCli(original, context)).toEqual({
      exitCode: 1,
      message: "An unexpected error occurred. Execution: execution-123",
    });
    expect(handler.report.mock.calls).toEqual([
      [original, "http", context],
      [original, "cli", context],
    ]);
  });

  it("reads each representation once and calls it with the original receiver and context", () => {
    const handler = new ReportingErrorHandler({ debug: true });
    const toHttpError = vi.fn((_context: ErrorRepresentationContext) => ({ statusCode: 409, message: "Conflict" }));
    const toCliError = vi.fn((_context: ErrorRepresentationContext) => ({ exitCode: 3, message: "Conflict" }));
    const readHttp = vi.fn(() => toHttpError);
    const readCli = vi.fn(() => toCliError);
    const original = Object.defineProperties({}, {
      toHttpError: { get: readHttp },
      toCliError: { get: readCli },
    });

    // Accessors may be stateful, so discovery and invocation must use the same method.
    expect(handler.handleHttp(original, context)).toEqual({ statusCode: 409, message: "Conflict" });
    expect(handler.handleCli(original, context)).toEqual({ exitCode: 3, message: "Conflict" });
    expect(readHttp).toHaveBeenCalledOnce();
    expect(readCli).toHaveBeenCalledOnce();
    expect(toHttpError).toHaveBeenCalledExactlyOnceWith(context);
    expect(toCliError).toHaveBeenCalledExactlyOnceWith(context);
    expect(toHttpError.mock.contexts).toEqual([original]);
    expect(toCliError.mock.contexts).toEqual([original]);
    expect(handler.report).not.toHaveBeenCalled();
  });

  it("reports the original error when its representation method throws", () => {
    const handler = new ReportingErrorHandler({ debug: false });
    const brokenRepresentation = () => { throw new Error("Private representation failure"); };
    const original = Object.assign(new Error("Original failure"), {
      toHttpError: brokenRepresentation, toCliError: brokenRepresentation,
    });

    expect(handler.handleHttp(original, context)).toMatchObject({
      statusCode: 500, message: "An unexpected error occurred.", extensions: { executionId: context.executionId },
    });
    expect(handler.handleCli(original, context)).toEqual({
      exitCode: 1, message: "An unexpected error occurred. Execution: execution-123",
    });
    expect(handler.report.mock.calls).toEqual([[original, "http", context], [original, "cli", context]]);
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

  it("renders null and primitive causes without treating them as errors with children", () => {
    const handler = new DefaultErrorHandler({ debug: true });
    const error = new AggregateError([null, undefined, 0], "Operation failed", { cause: false });

    // Primitive failures are leaves, including explicitly supplied falsy values.
    expect(handler.handleHttp(error, context).extensions).toStrictEqual({
      executionId: "execution-123",
      stack: error.stack,
      causes: ["false", "null", "undefined", "0"].map((message) => ({ error: "UnknownError", message })),
    });
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

describe("transport representation checks", () => {
  it.each([
    undefined,
    null,
    "failure",
    { toHttpError: true, toCliError: "invalid" },
  ])("rejects thrown values without callable representations (%#)", (error) => {
    expect(isHttpRepresentableError(error)).toBe(false);
    expect(isCliRepresentableError(error)).toBe(false);
  });

  it("recognizes the HTTP and CLI contracts independently", () => {
    const http = { toHttpError: () => ({ statusCode: 409, message: "Conflict" }) };
    const cli = { toCliError: () => ({ exitCode: 2, message: "Conflict" }) };

    expect(isHttpRepresentableError(http)).toBe(true);
    expect(isCliRepresentableError(http)).toBe(false);
    expect(isHttpRepresentableError(cli)).toBe(false);
    expect(isCliRepresentableError(cli)).toBe(true);
  });

  it("requires a thrown object with visible representation methods", () => {
    const methods = {
      toHttpError: vi.fn(() => ({ statusCode: 409, message: "Conflict" })),
      toCliError: vi.fn(() => ({ exitCode: 2, message: "Conflict" })),
    };
    const callable = Object.assign(() => {}, methods);
    const hidden = new Proxy(methods, { has: () => false });

    // A callable thrown value or hidden proxy property does not opt into a public response.
    for (const value of [callable, hidden]) {
      expect(isHttpRepresentableError(value)).toBe(false);
      expect(isCliRepresentableError(value)).toBe(false);
    }
  });
});

describe("getHttpErrorName", () => {
  it("supplies a generic reason phrase for an unrecognized status code", () => {
    expect(getHttpErrorName(409)).toBe("Conflict");
    expect(getHttpErrorName(599)).toBe("Error");
  });
});
