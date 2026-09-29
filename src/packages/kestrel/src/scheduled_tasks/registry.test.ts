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
