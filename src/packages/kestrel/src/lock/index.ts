export { locksDependency } from "./dependencies.js";
export {
  lockConfigBase,
  type LockConfig,
} from "./configuration.js";
export {
  LockAcquisitionAbortedError,
  LockAcquisitionTimeoutError,
  LockBatchAcquisitionAbortedError,
  LockBatchAcquisitionTimeoutError,
  LockLostError,
  LockReleasedError,
} from "./errors.js";
export { LockManager } from "./lock_manager.js";
export { LockProvider, type LockResource } from "./provider.js";
export {
  lockAcquisitionObservation,
  lockBatchAcquisitionObservation,
  lockExtensionObservation,
  lockReleaseObservation,
  recordLockInstrumentation,
  type LockAcquisitionMode,
  type LockAcquisitionObservationData,
  type LockAcquisitionResult,
  type LockBatchAcquisitionObservationData,
  type LockBatchAcquisitionResult,
  type LockExtensionObservationData,
  type LockExtensionResult,
  type LockInstrumentation,
  type LockInstrumentationEvent,
  type LockReleaseObservationData,
  type LockReleaseResult,
} from "./observations.js";
export {
  MemoryLockAdapter,
  type MemoryLockAdapterOptions,
  PostgresLockAdapter,
  type PostgresLockDatabase,
} from "./adapters/index.js";
export {
  lockLeases,
  type PostgresLockLease,
} from "./postgres_schema.js";
export {
  type Awaitable,
  type LockAcquireOptions,
  type LockAcquireRequest,
  type LockAdapter,
  type LockExtendRequest,
  type LockHandle,
  type LockLease,
  type LockManagerOptions,
  type LockPruneOptions,
  type LockReleaseRequest,
  type LockRunOptions,
  type LockRunContext,
  type Locks,
  type LockWaitOptions,
  type PrunableLockAdapter,
} from "./types.js";

export * from "./adapter_definition.js";

export { memoryLocks } from "./adapters/memory/index.js";
export { postgresLocks } from "./adapters/postgres/index.js";
