/** Raised when distributed loading is requested without a lock service. */
export class CacheLockUnavailableError extends Error {
  public constructor() {
    super(
      "Distributed cache loading requires a configured lock service.",
    );
    this.name = "CacheLockUnavailableError";
  }
}
