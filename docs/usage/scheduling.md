# Scheduling primitives

[Usage index](./README.md) · [Implementation and timer semantics](../implementation/scheduling.md)

For recurring application jobs, prefer [scheduled tasks](./scheduled_tasks.md). These low-level helpers are useful when an integration must own a cancellable delay or lease heartbeat itself.

## Wait until a delay or cancellation

Use a cancellable delay when a retry loop or integration must respond promptly to shutdown. The caller checks cancellation after the delay returns early.

```ts
import { abortableDelay } from "@kestrel/framework/scheduling";

async function waitBeforeRetry(signal: AbortSignal): Promise<void> {
  await abortableDelay(100, signal);
  // Cancellation resolves the delay early; the caller chooses what happens next.
  signal.throwIfAborted();
}
```

The timer does not keep Node.js alive. This is not a persistent schedule or a retry policy.

## Renew an externally owned lease

Use a heartbeat when an integration owns a lease outside the Kestrel lock manager. Keep renewal active during work, then drain it before releasing the lease.

```ts
import { startLeaseHeartbeat } from "@kestrel/framework/scheduling";

async function withHeartbeat(
  extend: () => Promise<void>,
  release: () => Promise<void>,
  work: (signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const heartbeat = startLeaseHeartbeat({
    intervalMs: 1_000,
    extend,
    // Signal the protected work to stop if renewal can no longer maintain ownership.
    onFailure: (error) => controller.abort(error),
  });
  try {
    await work(controller.signal);
  } finally {
    try {
      await heartbeat.close();
    } finally {
      // Await any active renewal before releasing ownership.
      await release();
    }
  }
}
```

Renewals never overlap. The first failure stops the heartbeat, and `close()` rethrows it after awaiting in-flight renewal. For Kestrel locks, use [runExclusive](./lock.md#protect-one-operation), which already owns this lifecycle.

## Use cases still to document

- Compose a bounded polling loop with cancellation-aware delays.
- Handle a failed renewal while draining and releasing an externally owned lease.
