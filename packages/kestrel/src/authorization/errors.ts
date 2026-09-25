import type {
  ErrorRepresentationContext,
  HttpErrorRepresentation,
  HttpRepresentableError,
} from "../errors/index.js";

/** Generic denial that intentionally does not reveal missing capabilities. */
export class AuthorizationDeniedError extends Error
  implements HttpRepresentableError
{
  public constructor() {
    super("Access is forbidden.");
    this.name = "AuthorizationDeniedError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 403,
      error: "Forbidden",
      message: "Access is forbidden.",
    };
  }
}
