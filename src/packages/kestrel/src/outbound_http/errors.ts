/** Raised when the total logical outbound deadline expires. */
export class OutboundHttpTimeoutError extends Error {
  public readonly name = "OutboundHttpTimeoutError";

  public constructor(
    public readonly operation: string,
    public readonly timeoutMs: number,
  ) {
    super(`Outbound HTTP operation "${operation}" exceeded its ${timeoutMs}ms deadline.`);
  }
}

/** Raised when caller cancellation aborts an outbound operation. */
export class OutboundHttpAbortedError extends Error {
  public readonly name = "OutboundHttpAbortedError";

  public constructor(
    public readonly operation: string,
    options: ErrorOptions = {},
  ) {
    super(`Outbound HTTP operation "${operation}" was aborted.`, options);
  }
}

/** Raised when fetch cannot produce an HTTP response. */
export class OutboundHttpTransportError extends Error {
  public readonly name = "OutboundHttpTransportError";

  public constructor(
    public readonly operation: string,
    options: ErrorOptions = {},
  ) {
    super(`Outbound HTTP operation "${operation}" failed before receiving a response.`, options);
  }
}

/** Raised by the convenience API for a non-successful HTTP response. */
export class OutboundHttpResponseError extends Error {
  public readonly name = "OutboundHttpResponseError";

  public constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
  ) {
    super(`Outbound HTTP operation "${operation}" failed with status ${status}.`);
  }
}

/** Raised when a successful response does not satisfy its declared decoder. */
export class OutboundHttpDecodeError extends Error {
  public readonly name = "OutboundHttpDecodeError";

  public constructor(
    public readonly operation: string,
    public readonly decoder: string,
    options: ErrorOptions = {},
  ) {
    super(`Outbound HTTP operation "${operation}" returned an invalid ${decoder} response.`, options);
  }
}

/** Raised before retaining a response body beyond its configured byte budget. */
export class OutboundHttpResponseTooLargeError extends Error {
  public readonly name = "OutboundHttpResponseTooLargeError";

  public constructor(
    public readonly operation: string,
    public readonly maxResponseBytes: number,
  ) {
    super(`Outbound HTTP operation "${operation}" exceeded its ${maxResponseBytes} byte response limit.`);
  }
}
