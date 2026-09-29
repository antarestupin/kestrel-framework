import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  App,
  executionContextDependency,
} from "../app/index.js";
import {
  MemoryWorkerAdapter,
  WorkerClient,
  WorkerScheduler,
} from "../workers/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import {
  createWorkflowActivityWorker,
  WorkflowActivityOutboxDispatcher,
  WorkflowWorkerCompletionSink,
} from "./worker_activity_transport.js";
import { getWorkflowActivityExecutionContext } from "./activity_transport.js";

describe("Worker-backed workflow activities", () => {
  it("publishes an outbox command and records its correlated Action result", async () => {
    const activityKeys: string[] = [];
    const double = defineAction({
      name: "numbers.double",
      input: z.number(),
      output: z.number(),
      dependencies: { executionContext: executionContextDependency },
      handler: (value, { executionContext }) => {
        activityKeys.push(
          getWorkflowActivityExecutionContext(executionContext)!.idempotencyKey,
        );
        return value * 2;
      },
    });
    const app = new App({}, {
      catalog: { actions: { double } },
    });
    await app.start();
    let workflowId = 0;
    const workflows = new MemoryWorkflowAdapter({
      activityDispatchMode: "outbox",
      createTaskId: () => `workflow-task-${++workflowId}`,
      createReservationToken: () => `workflow-token-${workflowId}`,
    });
    let workerId = 0;
    const workers = new MemoryWorkerAdapter({
      createId: () => `worker-job-${++workerId}`,
      createReservationToken: () => `worker-token-${workerId}`,
    });
    const activityWorker = createWorkflowActivityWorker(app);
    const client = new WorkerClient(workers);
    const dispatcher = new WorkflowActivityOutboxDispatcher(
      workflows,
      client,
      activityWorker,
    );
    const sink = new WorkflowWorkerCompletionSink(workflows);
    const scheduler = new WorkerScheduler(
      app,
      workers,
      [activityWorker],
      {
        slots: 2,
        leaseMs: 1_000,
        completeCorrelatedJob: (completion) => sink.complete(completion),
      },
    );

    await workflows.start({
      executionId: "execution-1",
      workflowName: "test.workflow",
      workflowVersion: 1,
      input: null,
    });
    const [activation] = await workflows.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    });
    expect(activation).toBeDefined();
    await workflows.commitActivation({
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: "execution-1",
      expectedRevision: 0,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: double.name,
        payload: {
          input: 2,
          options: {
            maxAttempts: 2,
            initialDelayMs: 1,
            backoffCoefficient: 2,
          },
        },
      }],
      outcome: { status: "waiting" },
    });

    await expect(dispatcher.runOnce()).resolves.toBe(1);
    expect(workers.inspectJobs()).toMatchObject([{
      identity: "execution-1:0",
      correlation: {
        namespace: "workflow.activity",
        data: { executionId: "execution-1", sequence: 0 },
      },
    }]);
    const publishedJob = workers.inspectJobs()[0]!;
    // Simulate a queue such as SQS delivering the same logical message twice.
    await workers.enqueue([{
      queue: publishedJob.queue,
      payload: publishedJob.payload,
      ...(publishedJob.correlation === undefined
        ? {}
        : { correlation: publishedJob.correlation }),
    }]);
    await scheduler.runOnce();

    const history = await workflows.getHistory("execution-1");
    expect(history.filter((event) => event.type === "command-completed"))
      .toMatchObject([{ sequence: 0, result: 4 }]);
    expect(workers.inspectJobs()).toHaveLength(0);
    expect(activityKeys).toEqual(["execution-1:0", "execution-1:0"]);
    expect((await workflows.getHistory("execution-1")).filter(
      (event) => event.type === "command-completed",
    )).toHaveLength(1);
  });
});
