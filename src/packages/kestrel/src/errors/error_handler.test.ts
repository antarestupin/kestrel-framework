import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DefaultErrorHandler,
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
});
