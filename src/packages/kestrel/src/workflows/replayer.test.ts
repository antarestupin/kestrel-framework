import {
  describe,
  expect,
  it,
} from "vitest";

import type { WorkflowActivationSnapshot } from "./history.js";
import { WorkflowReplayer } from "./replayer.js";

const baseSnapshot: WorkflowActivationSnapshot = {
  executionId: "execution-1",
  workflowName: "example.run",
  workflowVersion: 2,
  historyGeneration: 1,
  input: { value: "input" },
  revision: 0,
  history: [],
  cancellationRequested: false,
};

describe("WorkflowReplayer", () => {
  it("stages durable commands and waits without retaining the handler", async () => {
    const replayer = new WorkflowReplayer();

    await expect(replayer.replay(baseSnapshot, async (input, workflow) => {
      await workflow.command("activity", "example.read", input);
      return "done";
    })).resolves.toEqual({
      status: "waiting",
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.read",
        payload: { value: "input" },
      }],
    });
  });

  it("replays completed commands in durable completion order", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 4,
      history: [
        scheduled(0, "first"),
        scheduled(1, "second", 1),
        completed(1, 0, "B", 2),
        completed(0, 1, "A", 3),
      ],
    }, async (_input, workflow) => {
      const first = workflow.command<string>("activity", "first", null);
      const second = workflow.command<string>("activity", "second", null);
      return Promise.race([first, second]);
    });

    expect(result).toEqual({ status: "completed", output: "B", commands: [] });
  });

  it("returns a blocked diagnostic for incompatible command history", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 1,
      history: [scheduled(0, "old")],
    }, (_input, workflow) =>
      workflow.command("activity", "new", null));

    expect(result).toMatchObject({
      status: "blocked",
      error: {
        name: "WorkflowNondeterminismError",
        sequence: 0,
        expectedTarget: "old",
        actualTarget: "new",
      },
    });
  });

  it("rethrows recorded activity failures through ordinary try/catch", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 2,
      history: [
        scheduled(0, "fails"),
        {
          type: "command-completed",
          eventIndex: 1,
          sequence: 0,
          completionOrder: 0,
          error: { name: "ExampleError", message: "failed" },
          occurredAt: new Date(1),
        },
      ],
    }, async (_input, workflow) => {
      try {
        await workflow.command("activity", "fails", null);
      } catch (error) {
        return (error as Error).name;
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      output: "ExampleError",
    });
  });
});

function scheduled(sequence: number, target: string, eventIndex = 0) {
  return {
    type: "command-scheduled" as const,
    eventIndex,
    sequence,
    kind: "activity",
    target,
    payload: null,
    occurredAt: new Date(eventIndex),
  };
}

function completed(
  sequence: number,
  completionOrder: number,
  result: string,
  eventIndex: number,
) {
  return {
    type: "command-completed" as const,
    eventIndex,
    sequence,
    completionOrder,
    result,
    occurredAt: new Date(eventIndex),
  };
}
