import {
  describe,
  expect,
  it,
} from "vitest";

import {
  MemoryWorkflowReplayJournal,
  WorkflowInvalidSuspensionError,
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

  return {
    executionId: "test-execution",
    journal,
    runner: new WorkflowReplayRunner(journal),
  };
}

describe("WorkflowReplayRunner", () => {
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

  it("detects a changed command target at the same durable position", async () => {
    const { executionId, runner } = createExecution();

    await runner.activate(
      executionId,
      (_input: TestInput, workflow) =>
        workflow.command("activity", "original"),
    );

    await expect(runner.activate(
      executionId,
      (_input: TestInput, workflow) =>
        workflow.command("activity", "replacement"),
    )).rejects.toMatchObject({
      name: "WorkflowNondeterminismError",
      sequence: 0,
      expected: { target: "original" },
      actual: { target: "replacement" },
    });
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
    )).rejects.toBeInstanceOf(WorkflowInvalidSuspensionError);
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
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(WorkflowJournalConflictError),
    });
  });
});
