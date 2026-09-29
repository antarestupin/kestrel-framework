/** Raised when a lock cannot be acquired before its waiting deadline. */
export class LockAcquisitionTimeoutError extends Error {
  public constructor(public readonly key: string) {
    super(`Lock "${key}" could not be acquired before the timeout.`);
    this.name = "LockAcquisitionTimeoutError";
  }
}

/** Raised when lock acquisition is cancelled through an AbortSignal. */
export class LockAcquisitionAbortedError extends Error {
  public constructor(public readonly key: string) {
    super(`Lock acquisition for "${key}" was aborted.`);
    this.name = "LockAcquisitionAbortedError";
  }
}

/** Raised when a lock batch cannot be acquired before its waiting deadline. */
export class LockBatchAcquisitionTimeoutError extends Error {
  public constructor(public readonly keys: readonly string[]) {
    super(`Locks [${keys.map((key) => `"${key}"`).join(", ")}] could not be acquired before the timeout.`);
    this.name = "LockBatchAcquisitionTimeoutError";
  }
}

/** Raised when batch acquisition is cancelled through an AbortSignal. */
export class LockBatchAcquisitionAbortedError extends Error {
  public constructor(public readonly keys: readonly string[]) {
    super(`Lock acquisition for [${keys.map((key) => `"${key}"`).join(", ")}] was aborted.`);
    this.name = "LockBatchAcquisitionAbortedError";
  }
}

/** Raised when the store no longer recognizes a handle as the lease owner. */
export class LockLostError extends Error {
  public constructor(public readonly key: string) {
    super(`Lock "${key}" is no longer owned by this handle.`);
    this.name = "LockLostError";
  }
}

/** Raised when an operation requires a handle that has not been released. */
export class LockReleasedError extends Error {
  public constructor(public readonly key: string) {
    super(`Lock "${key}" has already been released.`);
    this.name = "LockReleasedError";
  }
}
