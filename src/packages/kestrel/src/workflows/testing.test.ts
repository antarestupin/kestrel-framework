import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import type { WorkflowExecutionStatus } from "./adapter.js";
import { WorkflowReplayer } from "./replayer.js";
import { jsonWorkflowPayloadCodec } from "./serialization.js";
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
  it("rejects an unknown execution before reading its history", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const history = vi.spyOn(adapter, "getHistory");
    await expect(exportWorkflowReplayFixture(adapter, "missing-fixture")).rejects.toThrow(/missing-fixture/u);
    expect(history).not.toHaveBeenCalled();
  });

  it("rejects export if an adapter stops returning the execution during the read", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = "vanished-fixture";
    const { execution } = await adapter.start({ executionId, workflowName: "fixture.versioned", workflowVersion: 1, input: null });
    // An external adapter can lose an execution between independent storage reads.
    vi.spyOn(adapter, "get").mockResolvedValueOnce(execution).mockResolvedValueOnce(undefined);
    await expect(exportWorkflowReplayFixture(adapter, executionId)).rejects.toThrow(/vanished-fixture.*changed while exporting/u);
  });

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

  it.each(["signal", "rotation"] as const)("rejects a fixture whose journal changes through %s during export", async (change) => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = "moving-fixture";
    await adapter.start({ executionId, workflowName: "fixture.versioned", workflowVersion: 1, input: "original" });
    const getHistory = adapter.getHistory.bind(adapter);
    vi.spyOn(adapter, "getHistory").mockImplementationOnce(async (id) => {
      if (change === "signal") {
        await adapter.sendSignal({ executionId, workflowName: "fixture.versioned", signalName: "changed", payload: true });
      } else {
        const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
        if (task === undefined) throw new Error("Test fixture did not reserve the workflow");
        expect(await adapter.continueAsNew({ executionId, taskId: task.id, reservationToken: task.reservationToken, expectedRevision: 0, workflowVersion: 2, input: "rotated" })).toBe(true);
      }
      return getHistory(id);
    });
    await expect(exportWorkflowReplayFixture(adapter, executionId)).rejects.toThrow(/changed while exporting/u);
    const fixture = await exportWorkflowReplayFixture(adapter, executionId);
    if (change === "signal") {
      expect(fixture.execution).toMatchObject({ historyGeneration: 1, revision: 1 });
      expect(fixture.history).toMatchObject([{ type: "signal-received", name: "changed", payload: true }]);
    } else {
      // Rotation resets the revision, so the generation check must stand on its own.
      expect(fixture.execution).toMatchObject({ historyGeneration: 2, revision: 0, workflowVersion: 2, input: "rotated" });
      expect(fixture.history).toEqual([]);
    }
  });

  it("redacts every payload location and omits error stacks unless requested", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = "redaction";
    const occurredAt = new Date(0);
    await adapter.start({ executionId, workflowName: "fixture.versioned", workflowVersion: 1, input: "input" });
    vi.spyOn(adapter, "getHistory").mockResolvedValue([
      { type: "command-scheduled", eventIndex: 0, occurredAt, sequence: 0, kind: "activity", target: "fixture.first", payload: "command" },
      { type: "signal-received", eventIndex: 1, occurredAt, signalId: "signal-1", name: "accepted", payload: "signal" },
      { type: "command-completed", eventIndex: 2, occurredAt, sequence: 0, completionOrder: 0, result: "result" },
      { type: "command-completed", eventIndex: 3, occurredAt, sequence: 1, completionOrder: 1, error: { name: "Failure", message: "failed", stack: "private stack" } },
      { type: "cancellation-requested", eventIndex: 4, occurredAt },
    ]);
    const sanitizePayload = vi.fn(() => "[redacted]");
    const redacted = await exportWorkflowReplayFixture(adapter, executionId, { sanitizePayload });
    expect(sanitizePayload.mock.calls).toEqual([
      ["input", "execution.input"], ["command", "history.0.payload"], ["signal", "history.1.payload"], ["result", "history.2.result"],
    ]);
    expect(redacted.execution.input).toBe("[redacted]");
    expect(redacted.history).toMatchObject([
      { type: "command-scheduled", occurredAt: occurredAt.toISOString(), payload: "[redacted]" },
      { type: "signal-received", occurredAt: occurredAt.toISOString(), payload: "[redacted]" },
      { type: "command-completed", occurredAt: occurredAt.toISOString(), result: "[redacted]" },
      { type: "command-completed", occurredAt: occurredAt.toISOString(), error: { name: "Failure", message: "failed" } },
      { type: "cancellation-requested", occurredAt: occurredAt.toISOString() },
    ]);
    expect(redacted.history[3]).not.toHaveProperty("error.stack");
    expect(parseWorkflowReplayFixture(stringifyWorkflowReplayFixture(redacted))).toStrictEqual(redacted);
    const complete = await exportWorkflowReplayFixture(adapter, executionId, { includeErrorStacks: true });
    expect(complete.history[3]).toHaveProperty("error.stack", "private stack");
  });

  it("rejects unknown formats, generations and event types at fixture import", () => {
    const valid = fixture(1, []);
    expect(() => parseWorkflowReplayFixture(JSON.stringify({ ...valid, formatVersion: 2 }))).toThrow();
    expect(() => parseWorkflowReplayFixture({ ...valid, execution: { ...valid.execution, historyGeneration: 0 } })).toThrow();
    expect(() => parseWorkflowReplayFixture({ ...valid, history: [{ type: "unknown", eventIndex: 0, occurredAt: new Date(0).toISOString() }] })).toThrow();
    expect(() => parseWorkflowReplayFixture({ ...valid, history: [{ type: "cancellation-requested", eventIndex: 0, occurredAt: "invalid date" }] })).toThrow();
  });

  it("accepts a valid ISO timestamp with a non-UTC offset", () => {
    const event = { type: "cancellation-requested", eventIndex: 0, occurredAt: "2026-01-01T02:30:00+02:30" } as const;
    expect(parseWorkflowReplayFixture(fixture(1, [event])).history).toStrictEqual([event]);
  });

  it("preserves every durable execution status in the replay fixture format", () => {
    const statuses: readonly WorkflowExecutionStatus[] = ["blocked", "cancelled", "cancelling", "completed", "failed", "pending", "queued", "running", "terminated", "waiting"];
    const valid = fixture(1, []);
    for (const status of statuses) {
      expect(parseWorkflowReplayFixture({ ...valid, execution: { ...valid.execution, status } }).execution.status).toBe(status);
    }
  });

  it("rejects a definition mismatch before replay and reports both names", async () => {
    const wrongDefinition = defineWorkflow({ name: "fixture.other", handler: () => undefined });
    const replayer = new WorkflowReplayer();
    const replay = vi.spyOn(replayer, "replay");
    await expect(assertWorkflowReplayCompatible(wrongDefinition, fixture(1, []), { replayer })).rejects.toMatchObject({
      name: "WorkflowReplayCompatibilityError",
      cause: { name: "TypeError", message: expect.stringMatching(/fixture\.versioned.*fixture\.other/u) },
    });
    expect(replay).not.toHaveBeenCalled();
  });

  it.each([1, 4])("rejects a pinned version outside the supported range: %s", async (version) => {
    const definition = defineWorkflow({ name: "fixture.versioned", version: { current: 3, supportedFrom: 2 }, handler: () => undefined });
    await expect(assertWorkflowReplayCompatible(definition, fixture(version, []))).rejects.toMatchObject({
      name: "WorkflowReplayCompatibilityError",
      cause: { name: "WorkflowExecutionVersionUnsupportedError", executionVersion: version, supportedFrom: 2, currentVersion: 3 },
    });
  });

  it("retains payload decoding failure as the fixture incompatibility cause", async () => {
    const definition = defineWorkflow({ name: "fixture.versioned", handler: () => undefined });
    const invalid = fixture(1, []);
    const cause = new Error("payload decoder unavailable");
    const codec = { encode: () => null, decode: () => { throw cause; } };
    await expect(assertWorkflowReplayCompatible(definition, invalid, { payloadCodec: codec })).rejects.toMatchObject({
      name: "WorkflowReplayCompatibilityError", message: expect.stringContaining(invalid.execution.executionId), fixture: invalid, cause,
    });
  });

  it.each(["now", "uuid"] as const)("forwards the injected %s source and codec to the production replayer", async (kind) => {
    const replayer = new WorkflowReplayer();
    const replay = vi.spyOn(replayer, "replay");
    const codec = {
      encode: vi.fn(jsonWorkflowPayloadCodec.encode.bind(jsonWorkflowPayloadCodec)),
      decode: vi.fn(jsonWorkflowPayloadCodec.decode.bind(jsonWorkflowPayloadCodec)),
    };
    const received = vi.fn();
    const definition = defineWorkflow({
      name: "fixture.versioned",
      input: z.object({ value: z.string().transform((value) => value.toUpperCase()) }),
      handler: async (input, context) => { received(input); await context[kind](); },
    });
    await expect(assertWorkflowReplayCompatible(definition, fixture(1, []), {
      replayer, payloadCodec: codec, now: () => 123, createUuid: () => "captured-id",
    })).resolves.toStrictEqual({ compatible: true, replayStatus: "waiting", newCommandCount: 1 });
    expect(replay).toHaveBeenCalledOnce();
    expect(codec.decode).toHaveBeenCalledWith({ value: "input" });
    expect(received).toHaveBeenCalledExactlyOnceWith({ value: "INPUT" });
    expect(codec.encode).toHaveBeenCalledExactlyOnceWith(kind === "now" ? 123 : "captured-id");
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
