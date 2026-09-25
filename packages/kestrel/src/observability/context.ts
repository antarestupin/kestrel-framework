import { AsyncLocalStorage } from "node:async_hooks";

import type { Observer } from "./observer.js";

/** Makes the observer for the active execution available to singletons. */
export interface ObserverContext {
  get(): Observer | undefined;
  run<Value>(
    observer: Observer | undefined,
    callback: () => Value,
  ): Value;
}

/** Propagates one scoped observer through the current asynchronous call tree. */
export class AsyncLocalObserverContext implements ObserverContext {
  private readonly storage = new AsyncLocalStorage<Observer | undefined>();

  public get(): Observer | undefined {
    return this.storage.getStore();
  }

  public run<Value>(
    observer: Observer | undefined,
    callback: () => Value,
  ): Value {
    return this.storage.run(observer, callback);
  }
}
