import {
  describe,
  expect,
  it,
} from "vitest";

import { every } from "./schedule.js";
import { defineScheduledTask } from "./task.js";
import { ScheduledTaskRegistry } from "./registry.js";

const task = defineScheduledTask({
  id: "example.task",
  schedule: every({ minutes: 1 }),
  handler: () => {},
});

describe("ScheduledTaskRegistry", () => {
  it("retains definitions and their provenance in registration order", () => {
    const registry = new ScheduledTaskRegistry().register(
      task,
      { kind: "provider", provider: "ExampleProvider" },
    );

    expect(registry.tasks).toEqual([task]);
    expect(registry.registrations).toEqual([{
      task,
      source: { kind: "provider", provider: "ExampleProvider" },
      path: ["example.task"],
    }]);
  });

  it("retains nested application catalog paths", () => {
    const registry = new ScheduledTaskRegistry().registerCatalog(
      { billing: { reconciliation: task } },
      { kind: "application" },
    );

    expect(registry.registrations[0]?.path).toEqual([
      "billing",
      "reconciliation",
    ]);
    expect(registry.catalog).toEqual({
      billing: { reconciliation: task },
    });
  });

  it("rejects duplicate ids across application and provider sources", () => {
    const registry = new ScheduledTaskRegistry().register(
      task,
      { kind: "application" },
    );

    expect(() => registry.register(
      task,
      { kind: "provider", provider: "ExampleProvider" },
    )).toThrow(/application catalog.*ExampleProvider/u);
  });
});

const other = defineScheduledTask({ id: "other.task", schedule: every({ seconds: 1 }), handler: () => undefined });
const third = defineScheduledTask({ id: "third.task", schedule: every({ seconds: 1 }), handler: () => undefined });

describe("scheduled task catalog ownership", () => {
  it("registers collections in order and isolates returned array containers", () => {
    const registry = new ScheduledTaskRegistry();
    expect(registry.registerMany([task, other], { kind: "application" })).toBe(registry);
    expect(registry.tasks).toEqual([task, other]);
    expect(registry.tasks).not.toBe(registry.tasks);
    expect(registry.registrations).not.toBe(registry.registrations);
    expect(registry.registrations.map(({ source }) => source)).toEqual([{ kind: "application" }, { kind: "application" }]);
  });

  it.each([
    [["branch"], ["branch"]],
    [["branch"], ["branch", "leaf"]],
    [["branch", "leaf"], ["branch"]],
  ])("rejects equal and leaf-to-branch declaration paths: %j vs %j", (first, second) => {
    const registry = new ScheduledTaskRegistry().register(task, { kind: "application" }, first);
    // The conflicting qualified paths must remain actionable in startup diagnostics.
    expect(() => registry.register(other, { kind: "application" }, second)).toThrow(expect.objectContaining({
      name: "TypeError",
      message: expect.stringContaining(first.length > second.length ? first.join(".") : second.join(".")),
    }));
    expect(registry.tasks).toEqual([task]);
  });

  it("retains distinct siblings and full nested paths without false collisions", () => {
    const parent = ["namespace"];
    const registry = new ScheduledTaskRegistry().registerCatalog({ branch: { first: task, second: other }, separate: { first: third } }, { kind: "application" }, parent);
    parent.push("mutated");
    expect(registry.catalog).toEqual({ namespace: { branch: { first: task, second: other }, separate: { first: third } } });
    expect(registry.registrations.map(({ path }) => path)).toEqual([["namespace", "branch", "first"], ["namespace", "branch", "second"], ["namespace", "separate", "first"]]);
    expect(new ScheduledTaskRegistry().registerCatalog({}, { kind: "application" }).catalog).toEqual({});
  });

  it("copies caller-owned path arrays", () => {
    const path = ["branch", "first"];
    const registry = new ScheduledTaskRegistry().register(task, { kind: "application" }, path);
    path.push("mutated");
    expect(registry.catalog).toEqual({ branch: { first: task } });
  });
});
