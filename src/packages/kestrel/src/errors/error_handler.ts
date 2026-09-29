import { STATUS_CODES } from "node:http";

import {
  type CliErrorRepresentation,
  type ErrorRepresentationContext,
  type HttpErrorRepresentation,
  isCliRepresentableError,
  isHttpRepresentableError,
} from "./representations.js";

export interface ErrorHandlerOptions {
  readonly debug: boolean;
}

export interface ErrorHandler {
  handleHttp(
    error: unknown,
    context: ErrorRepresentationContext,
  ): HttpErrorRepresentation;
  handleCli(
    error: unknown,
    context: ErrorRepresentationContext,
  ): CliErrorRepresentation;
}

interface ErrorDiagnostic {
  error: string;
  message: string;
  stack?: string;
}

/**
 * Converts expected errors through their opt-in contracts and safely handles
 * every unknown error that reaches a transport boundary.
 */
export class DefaultErrorHandler implements ErrorHandler {
  public constructor(
    private readonly options: ErrorHandlerOptions,
  ) {}

  public handleHttp(
    error: unknown,
    context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    const representation = this.resolveHttp(error, context);

    if (representation !== undefined) {
      return representation;
    }

    this.reportUnexpected(error, "http", context);

    if (!this.options.debug) {
      return {
        statusCode: 500,
        error: "Internal Server Error",
        message: "An unexpected error occurred.",
        extensions: { executionId: context.executionId },
      };
    }

    const diagnostic = createDiagnostic(error);
    const causes = createCauseDiagnostics(error);

    return {
      statusCode: 500,
      error: diagnostic.error,
      message: diagnostic.message,
      extensions: {
        executionId: context.executionId,
        ...(diagnostic.stack === undefined
          ? {}
          : { stack: diagnostic.stack }),
        ...(causes.length === 0 ? {} : { causes }),
      },
    };
  }

  public handleCli(
    error: unknown,
    context: ErrorRepresentationContext,
  ): CliErrorRepresentation {
    const representation = this.resolveCli(error, context);

    if (representation !== undefined) {
      return representation;
    }

    this.reportUnexpected(error, "cli", context);

    if (!this.options.debug) {
      return {
        exitCode: 1,
        message: `An unexpected error occurred. Execution: ${context.executionId}`,
      };
    }

    const diagnostics = [
      createDiagnostic(error),
      ...createCauseDiagnostics(error),
    ];

    return {
      exitCode: 1,
      message: diagnostics
        .map(formatCliDiagnostic)
        .join("\nCaused by: "),
    };
  }

  /** Allows application handlers to map errors before the default contract. */
  protected resolveHttp(
    error: unknown,
    context: ErrorRepresentationContext,
  ): HttpErrorRepresentation | undefined {
    return isHttpRepresentableError(error)
      ? error.toHttpError(context)
      : undefined;
  }

  /** Allows application handlers to map errors before the default contract. */
  protected resolveCli(
    error: unknown,
    context: ErrorRepresentationContext,
  ): CliErrorRepresentation | undefined {
    return isCliRepresentableError(error)
      ? error.toCliError(context)
      : undefined;
  }

  /** Application handlers can report unexpected failures to their logger. */
  protected reportUnexpected(
    _error: unknown,
    _transport: "http" | "cli",
    _context: ErrorRepresentationContext,
  ): void {}
}

function createDiagnostic(error: unknown): ErrorDiagnostic {
  if (!(error instanceof Error)) {
    return {
      error: "UnknownError",
      message: String(error),
    };
  }

  return {
    error: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

function createCauseDiagnostics(error: unknown): ErrorDiagnostic[] {
  const diagnostics: ErrorDiagnostic[] = [];
  const visited = new Set<unknown>([error]);
  let current = error instanceof Error ? error.cause : undefined;

  // Cause chains can be cyclic when errors originate in third-party code.
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    diagnostics.push(createDiagnostic(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return diagnostics;
}

function formatCliDiagnostic(diagnostic: ErrorDiagnostic): string {
  return diagnostic.stack
    ?? `${diagnostic.error}: ${diagnostic.message}`;
}

/** Returns the conventional HTTP reason phrase for a status code. */
export function getHttpErrorName(statusCode: number): string {
  return STATUS_CODES[statusCode] ?? "Error";
}
