# Locks

[Usage index](./README.md) · [Implementation and lease contracts](../implementation/lock.md)

Use finite leases to coordinate work on named resources. In Kestrel, configure `lockConfigBase`, register `LockProvider` after the database provider, and inject `locksDependency`. The callback APIs handle renewal and release for you.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  lockLeases,
} from "@kestrel/framework/lock";
export { utilsSchema } from "@kestrel/framework/db";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Protect one operation

Use an exclusive lease when concurrent callers could perform conflicting work on the same resource. The daily report example delegates renewal and release to the callback API.

```ts
import { LockManager, MemoryLockAdapter, type Locks } from "@kestrel/framework/lock";

// Standalone memory storage is suitable for tests or one process only.
const locks = new LockManager(new MemoryLockAdapter(), {
  namespace: "example", defaultTtlMs: 30_000, maxTtlMs: 300_000,
  defaultWaitTimeoutMs: 5_000, retryIntervalMs: 50,
});

async function generateReport(locks: Locks, write: (token: bigint, signal: AbortSignal) => Promise<void>) {
  await locks.runExclusive("report:daily", async (lock, { signal }) => {
    // The protected destination must enforce fencing if stale writes are possible.
    await write(lock.fencingToken, signal);
  }, { ttlMs: 30_000, waitTimeoutMs: 5_000 });
}
```

Pass the heartbeat signal to cancellable work. Losing a lease aborts this signal but cannot forcibly stop JavaScript. A fencing token only protects writes when their destination checks it.

## Acquire several resources together

Acquire a group of leases when an operation needs several records protected before it can start. The update callback only runs after the complete group has been acquired.

```ts
async function updatePair(locks: Locks, update: (signal: AbortSignal) => Promise<void>) {
  // Begin the update only after ownership of both resources is acquired.
  await locks.runExclusiveMany(["record:one", "record:two"], async (_handles, { signal }) => {
    await update(signal);
  }, { waitTimeoutMs: 1_000 });
}
```

Keys must be unique. The wait deadline covers the complete batch, and failed acquisition does not expose partial ownership. Callback completion attempts every release, including on failure.

## Skip work if a lock is already held

Try once when maintenance can be skipped because another owner is already doing it. This avoids waiting, but the caller owns the acquired handle and must release it.

```ts
async function tryMaintenance(locks: Locks, work: () => Promise<void>) {
  const lock = await locks.tryAcquire("maintenance");
  // Contention skips this optional maintenance pass; storage errors still propagate.
  if (lock === undefined) return;
  try {
    await work();
  } finally {
    // A manual handle must be released even if the protected work throws.
    await lock.release();
  }
}
```

Manual handles do not renew automatically: keep work within the TTL or call `extend`. `acquire` waits; `tryAcquire` makes one attempt. Storage failures propagate, wait expiry raises a timeout error, and failed ownership checks raise `LockLostError`. Never treat these failures as successful ownership.

## Use cases still to document

- Configure PostgreSQL lease pruning.
- Bound and cancel acquisition waits, including exhaustion handling.
- Renew a manually owned lease and stop work after lease loss.
- Enforce fencing tokens at the protected destination.
