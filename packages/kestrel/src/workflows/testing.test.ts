import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import {
  assertWorkflowReplayCompatible,
  exportWorkflowReplayFixture,
  parseWorkflowReplayFixture,
  stringifyWorkflowReplayFixture,
} from "./testing.js";
import type { WorkflowReplayFixtureEvent } from "./testing.js";
import { defineWorkflow } from "./workflow.js";

const firstAction = defineAction({
  name: "fixture.first",
  output: z.string(),
  handler: () => "first",
});
const secondAction = defineAction({
  name: "fixture.second",
  output: z.string(),
  handler: () => "second",
});

describe("workflow replay fixtures", () => {
  it("exports and imports a stable JSON representation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({
      executionId: "fixture-v1",
      workflowName: "fixture.versioned",
      workflowVersion: 1,
      input: { value: "input" },
    });
    const fixture = await exportWorkflowReplayFixture(adapter, "fixture-v1", {
      sanitizePayload: () => "[redacted]",
    });
    const parsed = parseWorkflowReplayFixture(
      stringifyWorkflowReplayFixture(fixture),
    );

    expect(parsed).toEqual(fixture);
    expect(parsed).toMatchObject({
      format: "kestrel.workflow-replay",
      formatVersion: 1,
      execution: { workflowVersion: 1, input: "[redacted]" },
    });
  });

  it("exercises both retained version branches against captured histories", async () => {
    const versioned = defineWorkflow({
      name: "fixture.versioned",
      version: { current: 2, supportedFrom: 1 },
      input: z.object({ value: z.string().refine(async () => true) }),
      validation: { input: "async" },
      handler: async (_input, workflow) => {
        await workflow.run(firstAction, null);
        if (workflow.version >= 2) await workflow.run(secondAction, null);
      },
    });
    const versionOne = fixture(1, [scheduled(0, "fixture.first")]);
    const versionTwo = fixture(2, [
      scheduled(0, "fixture.first"),
      completed(0, 0, "first", 1),
      scheduled(1, "fixture.second", 2),
    ]);

    await expect(assertWorkflowReplayCompatible(versioned, versionOne))
      .resolves.toMatchObject({ compatible: true, replayStatus: "waiting" });
    await expect(assertWorkflowReplayCompatible(versioned, versionTwo))
      .resolves.toMatchObject({ compatible: true, replayStatus: "waiting" });
  });

  it("fails at the first incompatible durable command", async () => {
    const changed = defineWorkflow({
      name: "fixture.versioned",
      version: { current: 1 },
      input: z.object({ value: z.string() }),
      handler: async (_input, workflow) => {
        await workflow.run(secondAction, null);
      },
    });

    await expect(assertWorkflowReplayCompatible(
      changed,
      fixture(1, [scheduled(0, "fixture.first")]),
    )).rejects.toMatchObject({
      name: "WorkflowReplayCompatibilityError",
      cause: {
        name: "WorkflowNondeterminismError",
        sequence: 0,
        expectedTarget: "fixture.first",
        actualTarget: "fixture.second",
      },
    });
  });
});

function fixture(version: number, history: readonly WorkflowReplayFixtureEvent[]) {
  return {
    format: "kestrel.workflow-replay" as const,
    formatVersion: 1 as const,
    execution: {
      executionId: `fixture-v${version}`,
      workflowName: "fixture.versioned",
      workflowVersion: version,
      historyGeneration: 1,
      input: { value: "input" },
      status: "waiting" as const,
      revision: history.length,
      cancellationRequested: false,
    },
    history,
  };
}

function completed(
  sequence: number,
  completionOrder: number,
  result: string,
  eventIndex: number,
): WorkflowReplayFixtureEvent {
  return {
    type: "command-completed",
    eventIndex,
    sequence,
    completionOrder,
    result,
    occurredAt: new Date(eventIndex).toISOString(),
  };
}

function scheduled(sequence: number, target: string, eventIndex = 0) {
  return {
    type: "command-scheduled" as const,
    eventIndex,
    sequence,
    kind: "activity",
    target,
    payload: {
      input: null,
      options: {
        maxAttempts: 1,
        initialDelayMs: 1_000,
        backoffCoefficient: 2,
      },
    },
    occurredAt: new Date(eventIndex).toISOString(),
  };
}
