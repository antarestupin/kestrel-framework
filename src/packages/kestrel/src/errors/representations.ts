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
  return readRepresentationMethod(error, "toHttpError") !== undefined;
}

/** Checks an unknown thrown value for the CLI representation contract. */
export function isCliRepresentableError(
  error: unknown,
): error is CliRepresentableError {
  return readRepresentationMethod(error, "toCliError") !== undefined;
}

type RepresentationMethods = HttpRepresentableError & CliRepresentableError;

/** Reads an optional transport method without letting accessors mask the original failure. */
export function readRepresentationMethod<Name extends keyof RepresentationMethods>(
  value: unknown,
  name: Name,
): RepresentationMethods[Name] | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  try {
    if (!(name in value)) return undefined;
    const method = (value as Partial<RepresentationMethods>)[name];
    return typeof method === "function" ? method : undefined;
  } catch {
    // A throwing property accessor or proxy trap is not an available representation.
    return undefined;
  }
}
