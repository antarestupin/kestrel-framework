import type {
  ErrorRepresentationContext,
  HttpErrorRepresentation,
  HttpRepresentableError,
} from "../errors/index.js";

/** Redirects an anonymous browser navigation to the configured login page. */
export class AtlasLoginRequiredError extends Error
  implements HttpRepresentableError
{
  public constructor(private readonly location: string) {
    super("Atlas login is required.");
    this.name = "AtlasLoginRequiredError";
  }

  public toHttpError(
    _context: ErrorRepresentationContext,
  ): HttpErrorRepresentation {
    return {
      statusCode: 302,
      message: "Atlas login is required.",
      headers: {
        "cache-control": "no-store",
        location: this.location,
      },
    };
  }
}
