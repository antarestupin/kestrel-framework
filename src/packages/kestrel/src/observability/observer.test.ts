import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defineObservation } from "./definitions.js";
import type { ObservationRecorder } from "./observer.js";
import { ScopedObserver } from "./observer.js";

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
