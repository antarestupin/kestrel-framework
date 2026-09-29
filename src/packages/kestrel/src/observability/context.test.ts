import {
  describe,
  expect,
  it,
} from "vitest";

import { AsyncLocalObserverContext } from "./context.js";
import type { Observer } from "./observer.js";

describe("AsyncLocalObserverContext", () => {
  it("keeps observers isolated across concurrent asynchronous work", async () => {
    const context = new AsyncLocalObserverContext();
    const first = createObserver();
    const second = createObserver();

    const observations = await Promise.all([
      context.run(first, async () => {
        await Promise.resolve();
        return context.get();
      }),
      context.run(second, async () => {
        await Promise.resolve();
        return context.get();
      }),
    ]);

    expect(observations).toEqual([first, second]);
    expect(context.get()).toBeUndefined();
  });

  it("allows an execution boundary to explicitly disable observation", () => {
    const context = new AsyncLocalObserverContext();
    const observer = createObserver();

    const result = context.run(observer, () =>
      context.run(undefined, () => context.get()));

    expect(result).toBeUndefined();
    expect(context.get()).toBeUndefined();
  });
});

/** Creates an inert observer whose identity is sufficient for context tests. */
function createObserver(): Observer {
  return { record: () => undefined };
}
