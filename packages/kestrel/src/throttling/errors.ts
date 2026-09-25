import type { RateLimitReservationSource } from "./types.js";

/** Raised when no capacity is immediately available. */
export class ThrottlingRejectedError extends Error {
  public constructor(
    public readonly definitionId: string,
    public readonly retryAt?: Date,
    public readonly source?: RateLimitReservationSource,
    public readonly remaining?: number,
  ) {
    super(`Throttling rejected admission for "${definitionId}".`);
    this.name = "ThrottlingRejectedError";
  }
}

/** Raised when a process-local dependency circuit does not admit a call. */
export class ThrottlingCircuitOpenError extends ThrottlingRejectedError {
  public constructor(
    definitionId: string,
    public readonly circuitId: string,
    retryAt?: Date,
  ) {
    super(definitionId, retryAt, "local");
    this.message = `Circuit "${circuitId}" rejected admission for "${definitionId}".`;
    this.name = "ThrottlingCircuitOpenError";
  }
}

/** Raised when a process-local pressure signal blocks new work. */
export class ThrottlingResourcePressureError extends ThrottlingRejectedError {
  public constructor(
    definitionId: string,
    public readonly constraintId: string,
    public readonly signalIds: readonly string[],
  ) {
    super(definitionId, undefined, "local");
    this.message = `Local resource pressure "${constraintId}" rejected admission for "${definitionId}".`;
    this.name = "ThrottlingResourcePressureError";
  }
}

/** Raised when bounded admission waiting reaches its deadline. */
export class ThrottlingAcquisitionTimeoutError extends Error {
  public constructor(public readonly definitionId: string) {
    super(`Timed out waiting for throttling capacity for "${definitionId}".`);
    this.name = "ThrottlingAcquisitionTimeoutError";
  }
}

/** Raised when admission waiting is cancelled cooperatively. */
export class ThrottlingAcquisitionAbortedError extends Error {
  public constructor(public readonly definitionId: string) {
    super(`Throttling admission was aborted for "${definitionId}".`);
    this.name = "ThrottlingAcquisitionAbortedError";
  }
}

/** Raised when the bounded manager queue cannot accept another waiter. */
export class ThrottlingQueueFullError extends Error {
  public constructor(public readonly definitionId: string) {
    super(`The throttling wait queue is full for "${definitionId}".`);
    this.name = "ThrottlingQueueFullError";
  }
}

/** Raised when work is submitted after the manager starts closing. */
export class ThrottlingClosedError extends Error {
  public constructor() {
    super("The throttling manager is closed.");
    this.name = "ThrottlingClosedError";
  }
}

/** Raised when application code completes the same permit more than once. */
export class ThrottlingPermitCompletedError extends Error {
  public constructor(public readonly definitionId: string) {
    super(`The throttling permit for "${definitionId}" is already completed.`);
    this.name = "ThrottlingPermitCompletedError";
  }
}

/** Raised when one operation can never fit within the configured burst. */
export class ThrottlingCostExceedsBurstError extends Error {
  public constructor(
    public readonly definitionId: string,
    public readonly cost: number,
    public readonly burst: number,
  ) {
    super(
      `Throttling cost ${cost} exceeds burst ${burst} for "${definitionId}".`,
    );
    this.name = "ThrottlingCostExceedsBurstError";
  }
}

/** Raised when authoritative throttling state cannot be reached safely. */
export class ThrottlingBackendUnavailableError extends Error {
  public constructor(options: { cause: unknown }) {
    super("The authoritative throttling backend is unavailable.", options);
    this.name = "ThrottlingBackendUnavailableError";
  }
}

/** Raised when one storage key is reused with incompatible bucket settings. */
export class ThrottlingDefinitionConflictError extends Error {
  public constructor(public readonly key: string) {
    super(`Throttling key "${key}" already uses another rate limit policy.`);
    this.name = "ThrottlingDefinitionConflictError";
  }
}

/** Raised when an adapter cannot preserve a requested composed guarantee. */
export class ThrottlingAdapterCapabilityError extends Error {
  public constructor(public readonly capability: string) {
    super(`The throttling adapter does not support ${capability}.`);
    this.name = "ThrottlingAdapterCapabilityError";
  }
}

/** Raised when an advanced policy does not receive a valid cost record. */
export class ThrottlingCostValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ThrottlingCostValidationError";
  }
}
