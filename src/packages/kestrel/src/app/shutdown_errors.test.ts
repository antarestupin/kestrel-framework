import { describe, expect, it, vi } from "vitest";

import { App, runtimeStoppingEvent, shutdownStartedEvent } from "./index.js";

const phases = ["runtime listener", "transport drain", "shutdown listener", "diagnostic flush"] as const;
type Phase = typeof phases[number];

/** Preserve original failures even when deferred listeners wrap them in aggregates. */
function causes(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
}

function rejectPhase(app: App<{}>, phase: Phase, failure: Error, close: ReturnType<typeof vi.fn>) {
  const reject = vi.fn(async () => {
    // Failure handling must still run while shared dependencies are available.
    expect(close).not.toHaveBeenCalled();
    throw failure;
  });
  if (phase === "runtime listener") app.eventBus.listenAsync(runtimeStoppingEvent, reject);
  if (phase === "shutdown listener") app.eventBus.listenAsync(shutdownStartedEvent, reject);
  if (phase === "transport drain") app.shutdown.registerDrain(reject);
  if (phase === "diagnostic flush") app.container.registerValue("observationRecorder", { flush: reject });
  return reject;
}

describe("application shutdown failure preservation", () => {
  it.each(phases)("reports an ordinary %s rejection and still disposes owned resources", async (phase) => {
    const app = new App({});
    const close = vi.fn();
    const failure = new Error(`Ordinary ${phase} failure`);
    app.container.registerValue("owned", {}, { dispose: close });
    const reject = rejectPhase(app, phase, failure, close);
    try {
      await app.start();
      const error = await app.dispose().then(() => undefined, (reason: unknown) => reason);
      expect(causes(error)).toContain(failure);
      expect(reject).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(app.state).toBe("disposed");
      // An ordinary failure must be observable independently of the deadline fallback.
      expect(app.shutdown.error).toBeUndefined();
    } finally {
      app.shutdown.finish();
      await app.container.dispose();
    }
  });

  it("retains failures from all shutdown phases while continuing later cleanup", async () => {
    const app = new App({});
    const close = vi.fn();
    app.container.registerValue("owned", {}, { dispose: close });
    const failures = phases.map((phase) => new Error(`Ordinary ${phase} failure`));
    const callbacks = phases.map((phase, index) => rejectPhase(app, phase, failures[index]!, close));
    try {
      await app.start();
      const error = await app.dispose().then(() => undefined, (reason: unknown) => reason);
      // Multiple phase failures need an identifiable shutdown summary and intact causes.
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toMatch(/shutdown/i);
      expect(causes(error)).toEqual(expect.arrayContaining(failures));
      for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(app.state).toBe("disposed");
      expect(app.shutdown.error).toBeUndefined();
    } finally {
      app.shutdown.finish();
      await app.container.dispose();
    }
  });

  it("keeps both concurrent stop callers pending until the runtime listener finishes", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const listener = vi.fn(() => blocked.promise);
    app.eventBus.listenAsync(runtimeStoppingEvent, listener);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await app.start();
      first = app.stop();
      second = app.stop();
      const settled = vi.fn();
      void first.then(settled, settled);
      void second.then(settled, settled);
      // Observe a full event-loop turn without relying on elapsed-time assertions.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(listener).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(app.state).toBe("stopping");
      blocked.resolve();
      await Promise.all([first, second]);
      expect(settled).toHaveBeenCalledTimes(2);
    } finally {
      blocked.resolve();
      await Promise.allSettled([first, second]);
      try { await app.dispose(); }
      finally {
        app.shutdown.finish();
        await app.container.dispose();
      }
    }
  });
});
