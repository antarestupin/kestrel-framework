import type {
  ErrorRepresentationContext,
  HttpErrorRepresentation,
  HttpRepresentableError,
} from "../errors/index.js";

/** Generic credential rejection that does not reveal the failed condition. */
export class InvalidCredentialsError extends Error
  implements HttpRepresentableError
{
  public constructor() {
    super("The supplied credentials are invalid.");
    this.name = "InvalidCredentialsError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 401,
      error: "Unauthorized",
      message: "The supplied credentials are invalid.",
    };
  }
}

/** Raised by protected operations when no valid principal was resolved. */
export class AuthenticationRequiredError extends Error
  implements HttpRepresentableError
{
  public constructor() {
    super("Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 401,
      error: "Unauthorized",
      message: "Authentication is required.",
    };
  }
}

/** Rejects cookie-authenticated unsafe requests from an untrusted origin. */
export class UntrustedAuthenticationOriginError extends Error
  implements HttpRepresentableError
{
  public constructor() {
    super("The request origin is not trusted.");
    this.name = "UntrustedAuthenticationOriginError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 403,
      error: "Forbidden",
      message: "The request origin is not trusted.",
    };
  }
}

/** Generic response for authentication attempt admission denial. */
export class AuthenticationRateLimitedError extends Error
  implements HttpRepresentableError
{
  public constructor() {
    super("Too many authentication attempts.");
    this.name = "AuthenticationRateLimitedError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 429,
      error: "Too Many Requests",
      message: "Too many authentication attempts.",
    };
  }
}

