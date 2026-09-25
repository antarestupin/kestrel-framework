import {
  describe,
  expect,
  it,
} from "vitest";

import type { StudioLog } from "../../logs/contract.js";
import type { StudioObservation } from "../contract.js";
import {
  combineExecutionGroups,
  describeLogExecution,
  describeObservationExecution,
  getLogExecutionId,
  groupExecutionArtifacts,
} from "./execution_grouping.js";

describe("correlated execution grouping", () => {
  it("keeps group discovery and observation order stable", () => {
    const observations = [
      observation("task-1:1", "execution.started"),
      observation("task-2:1", "execution.started"),
      observation("task-1:1", "database.query"),
    ];

    const groups = groupExecutionArtifacts(
      observations,
      (item) => item.executionId,
    );

    expect(groups.map((group) => ({
      executionId: group.executionId,
      names: group.items.map((item) => item.name),
    }))).toEqual([
      {
        executionId: "task-1:1",
        names: ["execution.started", "database.query"],
      },
      { executionId: "task-2:1", names: ["execution.started"] },
    ]);
  });

  it("describes workflow activities from lifecycle diagnostics", () => {
    const events = [observation("task-1:2", "execution.completed", {
      context: {
        "workflow.activityTarget": "send-welcome-email",
        "workflow.commandSequence": 2,
        "workflow.taskAttempt": 2,
        "workflow.taskId": "task-1",
        "workflow.taskKind": "activity",
      },
    })];

    expect(describeObservationExecution(events)).toEqual({
      title: "Activity · send-welcome-email",
      details: ["Attempt 2", "Command 2", "Task task-1"],
    });
  });

  it("groups and describes structured logs through flattened context", () => {
    const logs = [log({
      executionId: "timer-1:1",
      executionContext: {
        "workflow.commandSequence": 3,
        "workflow.taskKind": "timer",
      },
    })];

    expect(getLogExecutionId(logs[0]!)).toBe("timer-1:1");
    expect(describeLogExecution(logs)).toEqual({
      title: "Timer",
      details: ["Command 3"],
    });
  });

  it("places observations and logs from the same execution in one group", () => {
    const groups = combineExecutionGroups(
      [observation("task-1:1", "database.query")],
      [
        log({ executionId: "task-1:1" }),
        { ...log({ executionId: "task-2:1" }), id: 2 },
      ],
    );

    expect(groups.map((group) => ({
      executionId: group.executionId,
      logs: group.logs.length,
      observations: group.observations.length,
    }))).toEqual([
      { executionId: "task-1:1", logs: 1, observations: 1 },
      { executionId: "task-2:1", logs: 1, observations: 0 },
    ]);
  });
});

function observation(
  executionId: string,
  name: string,
  data: StudioObservation["data"] = {},
): StudioObservation {
  return {
    sequence: 1,
    id: `${executionId}-${name}`,
    executionId,
    occurredAt: "2026-08-20T10:00:00.000Z",
    name,
    category: "test",
    schemaVersion: 1,
    outcome: null,
    durationMs: null,
    data,
  };
}

function log(payload: Record<string, unknown>): StudioLog {
  return {
    id: 1,
    loggedAt: "2026-08-20T10:00:00.000Z",
    level: 30,
    message: "Test log",
    requestId: null,
    workload: null,
    payload,
    createdAt: "2026-08-20T10:00:00.001Z",
  };
}
