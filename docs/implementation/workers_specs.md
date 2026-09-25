# Workers

[Documentation](../README.md) · [Implementation index](./README.md)

> Design and scheduling reference, including deferred features. Use the [workers usage guide](../usage/workers.md) for implemented publication and execution recipes.

This document is about specs and not documentation, the actual documentation will go in [workers.md](./workers.md).

## Goals

In usual worker setups, one server is responsible for one message queue and is very sequential — reserve x jobs, handle them, mark as done, repeat. This results in a very sub-optimal resources usage.

The goal here is to maximize workers and resources efficiency. In the Postgres implementation, the goal is also to reduce the pressure on DB while keeping a feature-complete implementation.

## Features

- Retries with configurable manual or exponential backoff
- Dead-letter queue
- Fair queues: a bigger tenant in a queue must not take all the queue compute
- At least once strategy: workers will need to be idempotent or at least handle correctly replays
- Best-effort ordering at reservation time within a queue, not contractual
- Batch support
- Rate limits: no more than 100 messages in flight or per minute/second… for this queue
- Prioritize speed or batching (e.g. for costly APIs)
- Sleep after empty or traffic-low pull
- Weight on queues

## Global design

**Architecture**

A series of worker servers run, with a scheduler in each one of them. The scheduler manages the queues to work on from the worker point of view.

Workers are gathered in servers depending on their configuration, basically groups. For example standard workers on one side, CPU intensive ones on the other side.

When receiving the signal to stop:
- The scheduler stops reserving new jobs and releases the jobs that have not started yet from its incoming buffer
- Depending on scheduler configuration, it either waits for running handlers to complete or stops waiting for them
- When it does not wait, the scheduler may release running jobs immediately, knowingly allowing another worker to execute them concurrently, or leave them reserved until their leases expire
- The scheduler flushes its outgoing buffer, applying the acknowledgements, retries and moves to the dead-letter queue decided by completed handlers
- The process can now dispose

**In the library**

The backend is reached through an adapter, as in other similar libraries.

Workers are defined in a similar way actions and controllers are, with `defineWorker` and similar semantics. Its configuration contains the information on the related queue, its weight…

Depending on its configuration, the job handler may receive:
- Jobs one by one; then jobs ending in an error thrown will be considered as failing, others as successful
- An array of jobs to work on at once; it's then responsible to confirm success or failure of each job:
  - If it throws an error, all jobs are failing
  - It may return nothing, then all jobs are successful
  - It may yield a generic result created with `jobSuccess(jobId)` or `jobFail(jobId, { cause, retryDelayMs })` to report one job as successful or failed.
  - As soon as the handler yields one result, it must yield exactly one result for every job in the batch
  - A result referring to an unknown or duplicate job stops the generator; jobs without a successful yield fail without reverting successes already accepted
  - Each successful yield is validated and sent immediately to the shared acknowledgement buffer, so it may be durably acknowledged before the complete batch settles
  - A missing result or generator error fails only jobs that have not already yielded a success; the observed batch execution is still marked as failed

The library exposes an API to interact with the queues and send messages to them.
The adapter must be able to do the following actions: enqueue, reserve, ack, retry, deadLetter, release, extendLease, listReadyQueues. This list may be not exhaustive.

**In the app**

A file gathers the workers and queues configurations.

A dedicated bootstrap file will run the worker scheduler.

An npm command runs the worker bootstrap.

## Scheduler

Each worker server is running a scheduler that manages a batch of worker slots. The scheduler logic is not centralized among servers, each server has its own scheduler running with the same logic.

It retrieves information on the current context, including which queues contain messages (but not the messages count, which may be costly to compute). It caches this information in memory in order to retrieve this information at a lower pace.

Using the context, the workers configuration and memory of last reservations, it decides in which order prioritizing the queues for next reservation, and how many messages to try reserving for each one, based on:
- **queues weights**: they will be given a weight given their priority
- **fair queues strategy**: inside queues, bigger tenants must leave room for others; passed a threshold decided by configuration, messages from a tenant (identified by a group_id column) are unprioritized; will be implemented later
- **queues rotation**: e.g. round robin logic with random start across servers
- **queue priority set on speed vs batching**: for some queues it's important to batch as much as possible, e.g. to reduce costs
- **resources maximization**: one reservation query should reserve as many messages as possible, up to the configured limit
- **rate limiting**: to avoid putting too much pressure on external services; will be implemented later

It queries the message queue backend to reserve next jobs, then assigns them to the worker slots available, based on defined order and each worker's rate limits.

It buffers the incoming jobs and prefetches the next ones in order to minimize worker slots idle time and batch reservation queries. The reservation query doesn't fetch only jobs for one queue / worker, it fetches jobs to feed the buffer. The buffer size, threshold under which a fetch is triggered and the number of jobs to reserve per query are configurable.
It buffers successful job acknowledgements across concurrent handler invocations. Size and time thresholds are configurable. Adapters declare whether acknowledgements may be grouped globally or must be partitioned by queue. Failure transitions are still grouped at the cycle flush boundary.

On failed jobs, the scheduler increases the delay until their next attempt using exponential backoff. After a per-queue configured amount of retries, the job is moved into a dead-letter queue. The scheduler also stores the error in a dedicated column (present in job and DLQ tables).

If a retrieve attempt on a queue returns no result or under the worker batch size, after picking this result the scheduler may unprioritize this queue for a configured amount of time. If the queue is batch-prioritized, it will not reserve from it at all for this amount of time. The retrieved result itself is however handled with no wait, to not starve low-traffic queues.

## Postgres implementation

PG implementation uses a `job` and a `dead_letter_queue` table under the `workers` schema.

### Queues check query

Example query to list non-empty queues, to run at a lower pace and keep in memory:

```sql
-- With configuration table, can be stored and maintained with a cron
SELECT q.name
FROM worker_queues q
WHERE EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.queue = q.name
    AND j.available_at <= now()
  LIMIT 1 -- not useful because of the exists above, but shows the intent
);

-- Without table, list of queues passed from scheduler into query
SELECT q.queue
FROM unnest($1::text[]) AS q(queue)
WHERE EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.queue = q.queue
    AND j.available_at <= now()
);
```

### Reservation query

Example query to fetch next jobs by priority order (determined by the scheduler):

```sql
-- List of queues that should not be empty (from previous query), ordered by priority
-- The actual implementation may use parametized arrays instead, something like this:
-- SELECT * FROM unnest($3::text[], $4::integer[], $5::integer[], $6::boolean[])
WITH RECURSIVE preferred(
  queue,
  queue_order,
  reservation_limit,
  allow_overflow
) AS (
  VALUES
    ('A', 1, 60, true),
    ('B', 2, 40, true),
    ('C', 3, 30, false),
    ('D', 4, 20, true)
),

-- The recursive state contains all jobs selected so far and the remaining
-- global capacity. One queue is processed during each iteration.
allocation(queue_order, job_ids, remaining) AS (
  SELECT
    0,
    ARRAY[]::uuid[],
    $1::integer

  UNION ALL

  SELECT
    next_queue.queue_order,
    current.job_ids || picked.job_ids,
    current.remaining - cardinality(picked.job_ids)
  FROM allocation current

  -- Select the next configured queue.
  CROSS JOIN LATERAL (
    SELECT p.*
    FROM preferred p
    WHERE p.queue_order > current.queue_order
    ORDER BY p.queue_order
    LIMIT 1
  ) next_queue

  -- Reserve no more than this queue's allocation or the remaining capacity.
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      array_agg(candidate.id),
      ARRAY[]::uuid[]
    ) AS job_ids
    FROM (
      SELECT j.id
      FROM jobs j
      WHERE j.queue = next_queue.queue
        AND j.available_at <= now()
      ORDER BY j.available_at, j.id
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(
        next_queue.reservation_limit,
        current.remaining
      )
    ) candidate
  ) picked

  -- Stop visiting queues as soon as all slots are allocated.
  WHERE current.remaining > 0
),

-- Keep the state produced after the last visited queue.
first_pass_state AS MATERIALIZED (
  SELECT job_ids, remaining
  FROM allocation
  ORDER BY queue_order DESC
  LIMIT 1
),

first_pass AS MATERIALIZED (
  SELECT id
  FROM first_pass_state state
  CROSS JOIN LATERAL unnest(state.job_ids) AS selected(id)
),

-- If queues were unable to fulfill their allocations, ignore the original
-- limits and fill the remaining capacity according to queue order.
second_pass AS MATERIALIZED (
  SELECT j.id
  FROM jobs j
  INNER JOIN preferred p
    ON p.queue = j.queue
  CROSS JOIN first_pass_state state
  WHERE state.remaining > 0
    AND p.allow_overflow
    AND j.available_at <= now()
    AND j.id <> ALL(state.job_ids)
  ORDER BY
    p.queue_order,
    j.available_at,
    j.id
  FOR UPDATE OF j SKIP LOCKED
  LIMIT (
    SELECT remaining
    FROM first_pass_state
  )
),

selected_jobs AS MATERIALIZED (
  SELECT id FROM first_pass
  UNION ALL
  SELECT id FROM second_pass
)

UPDATE jobs j
SET
  available_at = now() + $2::interval,
  state = 'reserved',
  attempt = j.attempt + 1,
  reservation_token = uuidv7(),
  reserved_at = now()
FROM selected_jobs selected
WHERE j.id = selected.id
RETURNING j.*;
```

What this query does:
- It tries to reserve jobs in the queue prioritized order (made by the scheduler), up to each queue batch limit and to the global query limit
- If the global query limit has not been reached, it continues fetching jobs up to the global limit in an opportunistic way: in prioritized order but with no limit per queue
- It gathers the results together
- It sets the jobs as reserved and returns them

This query updates the jobs state instead of keeping the transaction open while the job is in flight, to avoid pressuring the DB. So it's important to make sure the DB client doesn't run this query in an app transaction that would stay open, this query should be committed as soon as possible — remember the connection in DI may be automatically in transaction mode.

### Move to DLQ query

Example query to move a job to the DLQ:

```sql
WITH moved AS (
  DELETE FROM workers.job
  WHERE id = $1
    AND reservation_token = $2
  RETURNING *
)
INSERT INTO workers.dead_letter_queue (...)
SELECT ...
FROM moved
RETURNING *;
```

### Reservation logic

Use a reservation based on available_at:

```
enqueue: available_at = desired_time
reserve: available_at = now() + lease; attempt += 1; generate a new reservation token
success: DELETE if the reservation token still matches
failure: if the reservation token still matches, set available_at = now() + retry_delay, set the last error and clear the token
failure after x retries: if the reservation token still matches, DELETE + insert into DLQ
release: if the reservation token still matches, make the job immediately available and clear the token
extend lease: if the reservation token still matches, move available_at to the new lease expiration
```

This logic prevents from needing a scheduled task to set jobs with timeout back to pending state. Here the reservation query directly sets the next available_at in case of an expired job.

The attempt count does not filter the reservation query. A job whose last allowed delivery ends because its lease expires may consequently be delivered once more. Only a confirmed failure decides whether to schedule a retry or atomically move the job to the dead-letter queue. This prevents a job from becoming permanently unavailable when a worker disappears during its last allowed attempt.

The reservation token identifies the current reservation generation. Every mutation made after reservation — acknowledgement, retry, move to the dead-letter queue, release or lease extension — must include both the job ID and this token in its condition. A mutation affecting no row means that the reservation is no longer current, for example because another worker has reserved the job since then; the stale result is ignored. This prevents an expired attempt from deleting or changing a newer reservation.

The lease delay must be high enough to not release job while it's waiting in the scheduler's buffer (configurable); also the scheduler may manually extend leases when detecting a lease may expire soon, preferrably in batches.

State column is used as a hint instead of a source of truth, e.g. to know how many messages are in flight per queue. It won't be correct for expired jobs, although it's easy to take in account in a query (`pending or (reserved and available_at <= now())`).

## Later

- Initially there will be a configured static number of worker slots per server, but later it could be dynamic, based on resources usage (CPU, RAM…).
- The scheduler may be able to estimate the jobs duration, for example using a moving avg duration.
- Optional queue-wide rate-limit shorthand on top of the implemented per-worker admission requirements
- Additional scheduling policies built on the shared throttling keys already used across worker and non-worker consumers
- Locally, run workers in server instead of dedicated process, or concurrently in `npm run dev`
- Inspect and manage queues and workers in Studio
- Observability events
- Idempotency key column to reduce the risk of a job pushed twice in a queue in case of retries
- Delayed action wrapper around workers
- Fair queues
- Error that prevent retries
- Normalize the batch jobs success / failure validation (sometimes you may yield, sometimes you may not)
- Jitter in backoff
