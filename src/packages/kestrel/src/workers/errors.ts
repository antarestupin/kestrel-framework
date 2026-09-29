/** Raised when a batch handler returns an ambiguous job result set. */
export class WorkerBatchResultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerBatchResultError";
  }
}

/** Requests a retry delay different from the worker's exponential policy. */
export class WorkerRetryError extends Error {
  public constructor(
    message: string,
    public readonly retryDelayMs: number,
    options?: ErrorOptions & { maxAttempts?: number },
  ) {
    super(message, options);
    this.name = "WorkerRetryError";

    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError(
        "Worker retry delays must be non-negative finite numbers.",
      );
    }

    if (options?.maxAttempts !== undefined
      && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new TypeError("Worker retry maxAttempts must be a positive integer.");
    }

    this.maxAttempts = options?.maxAttempts;
  }

  /** Optional per-job terminal attempt limit for dynamic transports. */
  public readonly maxAttempts: number | undefined;
}

/** Raised when one stable identity is reused for a different logical job. */
export class WorkerJobIdentityConflictError extends Error {
  public constructor(public readonly identity: string) {
    super(`Worker job identity "${identity}" already belongs to another job.`);
    this.name = "WorkerJobIdentityConflictError";
  }
}
