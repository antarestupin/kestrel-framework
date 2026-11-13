import { setImmediate } from "node:timers/promises";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MemoryWorkflowReplayJournal,
  WorkflowJournalConflictError,
  WorkflowNondeterminismError,
  WorkflowReplayRunner,
  type WorkflowReplayContext,
} from "./index.js";

interface TestInput {
  value: string;
}

function createExecution(version = 1) {
  const journal = new MemoryWorkflowReplayJournal();
  journal.createExecution({
    id: "test-execution",
    input: { value: "input" } satisfies TestInput,
    version,
  });
  let replayTurns = 0;

  return {
    executionId: "test-execution",
    journal,
    runner: new WorkflowReplayRunner(journal, { yieldExecution: () => {
      // Each fixture contains a bounded number of durable decisions.
      expect(++replayTurns).toBeLessThan(50);
      return setImmediate();
    } }),
  };
}

describe("WorkflowReplayRunner", () => {
  it("rejects an unknown command completion even when another command is scheduled", async () => {
    const { executionId, journal } = createExecution();
    const snapshot = await journal.appendCommands(executionId, 0, [{ sequence: 0, kind: "activity", target: "first" }]);

    await expect(journal.completeCommand(executionId, 1, "unexpected"))
      .rejects.toThrow('Workflow "test-execution" has no scheduled command 1.');
    await expect(journal.getExecution(executionId)).resolves.toEqual(snapshot);
  });

  it("counts only schedules when appending after an earlier command completion", async () => {
    const { executionId, journal } = createExecution();
    await journal.appendCommands(executionId, 0, [
      { sequence: 0, kind: "activity", target: "first" },
      { sequence: 1, kind: "timer", target: "next" },
    ]);
    await journal.completeCommand(executionId, 1, null);
    await expect(journal.appendCommands(executionId, 3, [
      { sequence: 2, kind: "activity", target: "third" },
    ])).resolves.toMatchObject({ revision: 4, history: [
      { type: "command-scheduled", sequence: 0 }, { type: "command-scheduled", sequence: 1 },
      { type: "command-completed", sequence: 1 }, { type: "command-scheduled", sequence: 2 },
    ] });
  });

  it.each([false, true])("persists a handler failure with its staged commands (async=%s)", async (asynchronous) => {
    const { executionId, runner } = createExecution();
    const failure = new Error("handler failed");
    const result = await runner.activate(executionId, (_input, workflow) => {
      void workflow.command("activity", "already-decided");
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    expect(result).toEqual({ status: "failed", error: failure, pendingCommands: [
      { sequence: 0, kind: "activity", target: "already-decided", status: "pending" },
    ] });
  });

  it.each([["", "valid"], ["activity", ""]])("rejects an empty command kind or target (%s/%s)", async (kind, target) => {
    const { executionId, runner } = createExecution();
    const result = await runner.activate(executionId, (_input, workflow) => workflow.command(kind!, target!));
    expect(result).toEqual({
      status: "failed", error: new TypeError("Workflow command kind and target must not be empty."), pendingCommands: [],
    });
  });

  it("replays sequential command results and appends only the next decision", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = async (
      input: TestInput,
      workflow: WorkflowReplayContext,
    ) => {
      const first = await workflow.command<string>("activity", "first");
      const second = await workflow.command<string>("activity", "second");
      return `${input.value}:${first}:${second}`;
    };

    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "waiting",
      pendingCommands: [{
        sequence: 0,
        kind: "activity",
        target: "first",
        status: "pending",
      }],
    });

    await journal.completeCommand(executionId, 0, "one");

    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "waiting",
      pendingCommands: [{
        sequence: 1,
        kind: "activity",
        target: "second",
        status: "pending",
      }],
    });

    await journal.completeCommand(executionId, 1, "two");

    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "completed",
      output: "input:one:two",
      pendingCommands: [],
    });
  });

  it("schedules native Promise.all inputs together and preserves result order", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = async (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => {
      const first = workflow.command<string>("activity", "first");
      const second = workflow.command<string>("activity", "second");
      return Promise.all([first, second]);
    };

    const firstActivation = await runner.activate(executionId, handler);
    expect(firstActivation).toMatchObject({
      status: "waiting",
      pendingCommands: [
        { sequence: 0, target: "first" },
        { sequence: 1, target: "second" },
      ],
    });

    await journal.completeCommand(executionId, 1, "second-result");
    await expect(runner.activate(executionId, handler)).resolves.toMatchObject({
      status: "waiting",
      pendingCommands: [{ sequence: 0, target: "first" }],
    });

    await journal.completeCommand(executionId, 0, "first-result");
    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "completed",
      output: ["first-result", "second-result"],
      pendingCommands: [],
    });
  });

  it("makes native Promise.race replay the historical completion winner", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = async (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => Promise.race([
      workflow.command<string>("activity", "first"),
      workflow.command<string>("activity", "second"),
    ]);

    await runner.activate(executionId, handler);
    await journal.completeCommand(executionId, 1, "second-won");
    await journal.completeCommand(executionId, 0, "first-finished-later");

    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "completed",
      output: "second-won",
      pendingCommands: [],
    });
  });

  it("completes a native race while retaining its pending loser", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = async (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => Promise.race([
      workflow.command<string>("activity", "slow"),
      workflow.command<string>("activity", "fast"),
    ]);

    await runner.activate(executionId, handler);
    await journal.completeCommand(executionId, 1, "fast-result");

    await expect(runner.activate(executionId, handler)).resolves.toEqual({
      status: "completed",
      output: "fast-result",
      pendingCommands: [{
        sequence: 0,
        kind: "activity",
        target: "slow",
        status: "pending",
      }],
    });
  });

  it("does not duplicate a decision when execution stopped before result persistence", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => workflow.command<string>("activity", "external-effect");

    await runner.activate(executionId, handler);

    // The external effect may have happened, but its result was not recorded.
    await runner.activate(executionId, handler);

    const interruptedSnapshot = await journal.getExecution(executionId);
    expect(interruptedSnapshot.history).toEqual([{
      type: "command-scheduled",
      sequence: 0,
      kind: "activity",
      target: "external-effect",
    }]);

    await journal.completeCommand(executionId, 0, "recorded-later");
    await expect(runner.activate(executionId, handler)).resolves.toMatchObject({
      status: "completed",
      output: "recorded-later",
    });
  });

  it("deduplicates repeated terminal result delivery", async () => {
    const { executionId, journal, runner } = createExecution();
    const handler = (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => workflow.command<string>("activity", "effect");

    await runner.activate(executionId, handler);

    await expect(
      journal.completeCommand(executionId, 0, "first"),
    ).resolves.toBe(true);
    await expect(
      journal.completeCommand(executionId, 0, "duplicate"),
    ).resolves.toBe(false);
    await expect(runner.activate(executionId, handler)).resolves.toMatchObject({
      status: "completed",
      output: "first",
    });
  });

  it.each([
    { kind: "activity", target: "replacement" },
    { kind: "timer", target: "original" },
  ])("detects a changed durable identity $kind:$target", async ({ kind, target }) => {
    const { executionId, runner } = createExecution();

    await runner.activate(
      executionId,
      (_input: TestInput, workflow) =>
        workflow.command("activity", "original"),
    );

    await expect(runner.activate(
      executionId,
      (_input: TestInput, workflow) =>
        workflow.command(kind, target),
    )).rejects.toMatchObject({
      name: "WorkflowNondeterminismError",
      sequence: 0,
      expected: { target: "original" },
      actual: { kind, target },
      message: `Workflow "test-execution" is non-deterministic at command 0: expected activity:original, received ${kind}:${target}.`,
    });
  });

  it("does not issue an empty append for a fully replayed activation", async () => {
    const { executionId, journal, runner } = createExecution();
    const append = vi.spyOn(journal, "appendCommands");
    await expect(runner.activate(executionId, () => "complete")).resolves.toEqual({
      status: "completed", output: "complete", pendingCommands: [],
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects an unmanaged suspension even after a recorded command resolved", async () => {
    const { executionId, journal, runner } = createExecution();
    await journal.appendCommands(executionId, 0, [{ sequence: 0, kind: "activity", target: "already-recorded" }]);
    await journal.completeCommand(executionId, 0, "completed");
    await expect(runner.activate(executionId, async (_input, replay) => {
      await replay.command("activity", "already-recorded");
      return new Promise(() => undefined);
    })).rejects.toThrow("suspended without an unresolved durable command.");
  });

  it("rejects a handler that returns before replaying its recorded command", async () => {
    const { executionId, journal, runner } = createExecution();
    await journal.appendCommands(executionId, 0, [{ sequence: 0, kind: "activity", target: "required" }]);
    await expect(runner.activate(executionId, () => "no command")).rejects.toThrow(
      `Workflow "${executionId}" is non-deterministic at command 0: expected activity:required, received no command.`,
    );
  });

  it("orders historical commands by sequence even when the journal returns a different order", async () => {
    const { executionId, journal } = createExecution();
    await journal.appendCommands(executionId, 0, [
      { sequence: 0, kind: "activity", target: "first" }, { sequence: 1, kind: "activity", target: "second" },
    ]);
    await journal.completeCommand(executionId, 1, "two");
    await journal.completeCommand(executionId, 0, "one");
    const snapshot = await journal.getExecution(executionId);
    vi.spyOn(journal, "getExecution").mockResolvedValue({ ...snapshot, history: [...snapshot.history].reverse() });
    const runner = new WorkflowReplayRunner(journal);
    await expect(runner.activate(executionId, async (_input, replay) => {
      const first = replay.command("activity", "first");
      const second = replay.command("activity", "second");
      return Promise.all([first, second]);
    })).resolves.toEqual({ status: "completed", output: ["one", "two"], pendingCommands: [] });
  });

  it("detects history commands removed before a suspension point", async () => {
    const { executionId, runner } = createExecution();

    await runner.activate(
      executionId,
      async (_input: TestInput, workflow) => Promise.all([
        workflow.command("activity", "first"),
        workflow.command("activity", "second"),
      ]),
    );

    await expect(runner.activate(
      executionId,
      (_input: TestInput, workflow) =>
        workflow.command("activity", "first"),
    )).rejects.toBeInstanceOf(WorkflowNondeterminismError);
  });

  it("distinguishes repeated targets by durable command position", async () => {
    const { executionId, runner } = createExecution();

    const activation = await runner.activate(
      executionId,
      async (_input: TestInput, workflow) => Promise.all([
        workflow.command("activity", "repeated"),
        workflow.command("activity", "repeated"),
      ]),
    );

    expect(activation).toMatchObject({
      pendingCommands: [
        { sequence: 0, target: "repeated" },
        { sequence: 1, target: "repeated" },
      ],
    });
  });

  it("uses one handler branch for concurrently supported execution versions", async () => {
    const journal = new MemoryWorkflowReplayJournal();
    journal.createExecution({ id: "version-one", input: {}, version: 1 });
    journal.createExecution({ id: "version-two", input: {}, version: 2 });
    const runner = new WorkflowReplayRunner(journal);
    const handler = async (_input: object, workflow: WorkflowReplayContext) => {
      await workflow.command("activity", "base");

      if (workflow.version >= 2) {
        await workflow.command("activity", "new-in-version-two");
      }

      return workflow.command("activity", "finish");
    };

    await runner.activate("version-one", handler);
    await runner.activate("version-two", handler);
    await journal.completeCommand("version-one", 0, undefined);
    await journal.completeCommand("version-two", 0, undefined);

    await expect(runner.activate("version-one", handler)).resolves.toMatchObject({
      pendingCommands: [{ sequence: 1, target: "finish" }],
    });
    await expect(runner.activate("version-two", handler)).resolves.toMatchObject({
      pendingCommands: [{ sequence: 1, target: "new-in-version-two" }],
    });
  });

  it("rejects suspension on a promise not owned by the workflow runtime", async () => {
    const { executionId, runner } = createExecution();

    await expect(runner.activate(
      executionId,
      () => new Promise<string>(() => undefined),
    )).rejects.toMatchObject({
      name: "WorkflowInvalidSuspensionError",
      message: `Workflow "${executionId}" suspended without an unresolved durable command.`,
    });
  });

  it("rejects one of two concurrent appends from the same journal revision", async () => {
    const { executionId, runner } = createExecution();
    const handler = (
      _input: TestInput,
      workflow: WorkflowReplayContext,
    ) => workflow.command("activity", "single-decision");

    const results = await Promise.allSettled([
      runner.activate(executionId, handler),
      runner.activate(executionId, handler),
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.reason).toBeInstanceOf(WorkflowJournalConflictError);
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "WorkflowJournalConflictError",
        message: 'Workflow "test-execution" journal revision changed from 0 to 1.',
      }),
    });
  });
});

describe("MemoryWorkflowReplayJournal", () => {
  it("advances the optimistic revision on completion and counts only scheduled command positions", async () => {
    const { executionId, journal } = createExecution();
    await journal.appendCommands(executionId, 0, [{ sequence: 0, kind: "activity", target: "first" }]);
    await expect(journal.completeCommand(executionId, 1, "missing")).rejects.toThrow("no scheduled command 1");
    await expect(journal.completeCommand(executionId, 0, "finished")).resolves.toBe(true);
    await expect(journal.appendCommands(executionId, 1, [])).rejects.toBeInstanceOf(WorkflowJournalConflictError);
    await expect(journal.appendCommands(executionId, 2, [{ sequence: 1, kind: "activity", target: "second" }]))
      .resolves.toMatchObject({ revision: 3 });
  });

  it("rejects duplicate or invalid executions and keeps the original snapshot", async () => {
    const { executionId, journal } = createExecution(3);
    expect(() => journal.createExecution({ id: executionId, version: 4, input: "replacement" })).toThrow(
      `Workflow execution "${executionId}" already exists.`,
    );
    for (const version of [0, -1, 1.5, Infinity]) {
      expect(() => journal.createExecution({ id: "invalid", version, input: null })).toThrow(
        "Workflow execution version must be a positive integer.",
      );
    }
    await expect(journal.getExecution("invalid")).rejects.toThrow('Unknown workflow execution "invalid".');
    await expect(journal.getExecution(executionId)).resolves.toEqual({
      id: executionId, version: 3, input: { value: "input" }, revision: 0, history: [],
    });
  });

  it("rejects a command sequence gap before appending any of the batch", async () => {
    const { executionId, journal } = createExecution();
    await expect(journal.appendCommands(executionId, 0, [
      { sequence: 0, kind: "activity", target: "valid" },
      { sequence: 2, kind: "activity", target: "sequence-gap" },
    ])).rejects.toThrow("Expected command sequence 1, received 2.");
    await expect(journal.completeCommand(executionId, 0, "unscheduled")).rejects.toThrow(
      `Workflow "${executionId}" has no scheduled command 0.`,
    );
    await expect(journal.getExecution(executionId)).resolves.toMatchObject({ revision: 0, history: [] });
  });
});
