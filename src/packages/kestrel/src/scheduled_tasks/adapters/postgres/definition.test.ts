import { expect, it, vi } from "vitest";

import type { AdapterDependencyResolver } from "../../../di/adapter.js";
import { dep } from "../../../di/index.js";
import { scheduledTasksConfigBase } from "../../configuration.js";
import type { PostgresScheduledTaskDatabase } from "./adapter.js";
import { postgresScheduledTasks } from "./definition.js";
import { scheduledTaskStates } from "./schema.js";

it("resolves the explicitly declared PostgreSQL dependency only when constructing its adapter", async () => {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  // A borrowed database exposes the public Drizzle composition used by reconciliation.
  const database = { insert } as unknown as PostgresScheduledTaskDatabase;
  const descriptor = dep<PostgresScheduledTaskDatabase>("scheduled-database");
  const resolve = vi.fn((requested: unknown) => {
    expect(requested).toBe(descriptor);
    return database;
  });
  const definition = postgresScheduledTasks(descriptor);
  expect(resolve).not.toHaveBeenCalled();
  const resolver: AdapterDependencyResolver = <Value>(dependency: Parameters<AdapterDependencyResolver>[0]): Value => resolve(dependency) as unknown as Value;
  const adapter = definition.create(resolver, scheduledTasksConfigBase.schema.parse({}));
  const registration = { taskId: "explicit.database", nextScheduledAt: new Date("2026-01-01T00:00:00.000Z") };
  await adapter.reconcile([registration]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(descriptor);
  expect(insert).toHaveBeenCalledExactlyOnceWith(scheduledTaskStates);
  expect(values).toHaveBeenCalledExactlyOnceWith([registration]);
  expect(onConflictDoNothing).toHaveBeenCalledExactlyOnceWith({ target: scheduledTaskStates.taskId });
});
