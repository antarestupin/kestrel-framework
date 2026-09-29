/** Context shared with error representations produced for one execution. */
export interface ErrorRepresentationContext {
  readonly executionId: string;
}

/** Transport-ready HTTP error produced without depending on Fastify. */
export interface HttpErrorRepresentation {
  readonly statusCode: number;
  readonly error?: string;
  readonly message: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** Opt-in contract for errors that intentionally expose an HTTP response. */
export interface HttpRepresentableError {
  toHttpError(
    context: ErrorRepresentationContext,
  ): HttpErrorRepresentation;
}

/** Transport-ready CLI error produced without depending on Commander. */
export interface CliErrorRepresentation {
  readonly exitCode: number;
  readonly message: string;
}

/** Opt-in contract for errors that intentionally expose a CLI response. */
export interface CliRepresentableError {
  toCliError(
    context: ErrorRepresentationContext,
  ): CliErrorRepresentation;
}

/** Checks an unknown thrown value for the HTTP representation contract. */
export function isHttpRepresentableError(
  error: unknown,
): error is HttpRepresentableError {
  return hasMethod(error, "toHttpError");
}

/** Checks an unknown thrown value for the CLI representation contract. */
export function isCliRepresentableError(
  error: unknown,
): error is CliRepresentableError {
  return hasMethod(error, "toCliError");
}

function hasMethod(value: unknown, name: string): boolean {
  return typeof value === "object"
    && value !== null
    && name in value
    && typeof (value as Record<string, unknown>)[name] === "function";
}
