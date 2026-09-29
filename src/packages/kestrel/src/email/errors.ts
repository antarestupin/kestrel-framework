/** Stable failure categories shared by every email transport. */
export type EmailErrorCode =
  | "authentication"
  | "cancelled"
  | "invalid-message"
  | "provider"
  | "rate-limited"
  | "timeout"
  | "transport"
  | "unavailable"
  | "unsupported";

export interface EmailDriverErrorOptions extends ErrorOptions {
  readonly retryable?: boolean;
  readonly statusCode?: number;
}

/** Error adapters throw to preserve transport-neutral failure semantics. */
export class EmailDriverError extends Error {
  public readonly name = "EmailDriverError";

  public readonly retryable: boolean;

  public readonly statusCode: number | undefined;

  public constructor(
    public readonly code: EmailErrorCode,
    message: string,
    options: EmailDriverErrorOptions = {},
  ) {
    super(message, options);
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

/** Application-facing failure enriched with the stable logical operation. */
export class EmailSendError extends Error {
  public readonly name = "EmailSendError";

  public constructor(
    public readonly operation: string,
    public readonly code: EmailErrorCode,
    public readonly retryable: boolean,
    public readonly statusCode: number | undefined,
    options: ErrorOptions = {},
  ) {
    super(`Email operation "${operation}" failed (${code}).`, options);
  }
}

/** Prevents adapter-specific exceptions from escaping the unified API. */
export function normalizeEmailSendError(
  operation: string,
  error: unknown,
): EmailSendError {
  if (error instanceof EmailSendError) {
    return error;
  }

  if (error instanceof EmailDriverError) {
    return new EmailSendError(
      operation,
      error.code,
      error.retryable,
      error.statusCode,
      { cause: error },
    );
  }

  return new EmailSendError(
    operation,
    "transport",
    false,
    undefined,
    { cause: error },
  );
}
