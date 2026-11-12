import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defineObservation } from "./definitions.js";
import type { ObservationRecorder } from "./observer.js";
import { DelegatingObservationRecorder, ScopedObserver } from "./observer.js";

describe("ScopedObserver", () => {
  it("adds execution context and definition metadata", () => {
    const recorder: ObservationRecorder = {
      enqueue: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getHealth: () => emptyHealth(),
    };
    const observer = new ScopedObserver("execution-1", recorder);
    const observation = defineObservation<{
      result: "hit" | "miss";
    }>({
      name: "cache.access",
      category: "cache",
    });
    const occurredAt = new Date("2026-08-07T10:00:00.000Z");

    observer.record(
      observation,
      { result: "hit" },
      { occurredAt, durationMs: 4, outcome: "success" },
    );

    expect(recorder.enqueue).toHaveBeenCalledWith({
      id: expect.any(String),
      executionId: "execution-1",
      occurredAt,
      name: "cache.access",
      category: "cache",
      schemaVersion: 1,
      outcome: "success",
      durationMs: 4,
      data: { result: "hit" },
    });

    if (false) {
      // @ts-expect-error Definitions reject payloads outside their contract.
      observer.record(observation, { result: "unknown" });
    }
  });

  it("uses a caller-reserved identity for cross-store correlation", () => {
    const recorder: ObservationRecorder = {
      enqueue: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getHealth: () => emptyHealth(),
    };
    const observer = new ScopedObserver("execution-1", recorder);
    const observation = defineObservation({
      name: "email.send",
      category: "email",
    });

    observer.record(observation, {}, {
      id: "00000000-0000-4000-8000-000000000020",
    });

    expect(recorder.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000020",
    }));
  });

  it("forwards an explicit schema version and supplies defaults for an unadorned event", () => {
    const enqueue = vi.fn<ObservationRecorder["enqueue"]>();
    const observer = new ScopedObserver("execution-2", {
      enqueue, flush: async () => {}, close: async () => {}, getHealth: emptyHealth,
    });
    const definition = defineObservation({ name: "task.completed", category: "task", schemaVersion: 3 });
    const data = { task: "reports" };
    const occurredAt = new Date("2026-08-07T10:00:00.000Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(occurredAt);
    try {
      observer.record(definition, data);
      expect(enqueue.mock.calls[0]?.[0]).toStrictEqual({
        id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
        executionId: "execution-2", occurredAt, name: "task.completed", category: "task", schemaVersion: 3, data,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("forwards all recorder operations to the active backend and ignores stale detaches", async () => {
  const health = { ...emptyHealth(), status: "degraded" as const, pendingCount: 4 };
  const active = { enqueue: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}), getHealth: () => health };
  const stale = { ...active, getHealth: emptyHealth };
  const recorder = new DelegatingObservationRecorder();
  const observer = new ScopedObserver("execution", recorder);
  const definition = defineObservation({ name: "test.event", category: "test" });

  expect(recorder.getHealth()).toStrictEqual(emptyHealth());
  observer.record(definition, { status: "unowned" });
  recorder.use(active);
  recorder.clear(stale);
  observer.record(definition, { status: "recorded" });
  expect(active.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: { status: "recorded" } }));
  expect(recorder.getHealth()).toBe(health);
  await recorder.flush();
  await recorder.close();
  expect(active.flush).toHaveBeenCalledOnce();
  expect(active.close).toHaveBeenCalledOnce();

  recorder.clear(active);
  await recorder.flush();
  await recorder.close();
  expect(active.flush).toHaveBeenCalledOnce();
  expect(active.close).toHaveBeenCalledOnce();
  expect(recorder.getHealth()).toStrictEqual(emptyHealth());
});

function emptyHealth() {
  return {
    status: "healthy" as const,
    pendingCount: 0,
    droppedCount: 0,
    droppedByOverflow: 0,
    droppedByStorageFailure: 0,
    consecutiveStorageFailures: 0,
  };
}
