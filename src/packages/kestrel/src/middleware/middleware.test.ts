import { describe, expect, it, vi } from "vitest";

import { createDependencyContainer, dep } from "../di/index.js";
import {
  defineMiddleware,
  runMiddlewarePipeline,
} from "./index.js";

describe("middleware pipeline", () => {
  it("rejects a name that is empty after trimming whitespace", () => {
    expect(() => defineMiddleware(" \t\n ", {
      handler: (_context, next) => next(),
    })).toThrow(new TypeError("A middleware name cannot be empty."));
  });

  it("replays the complete downstream suffix for every next call", async () => {
    const calls: string[] = [];
    const retry = defineMiddleware("retry", {
      handler: async (_context, next) => {
        calls.push("retry:before");
        const first = await next();
        await next();
        calls.push("retry:after");

        return first;
      },
    });
    const attempt = defineMiddleware("attempt", {
      handler: async (_context, next) => {
        calls.push("attempt:before");
        const result = await next();
        calls.push("attempt:after");

        return result;
      },
    });
    let terminalCalls = 0;

    const result = await runMiddlewarePipeline(
      [retry, attempt],
      {},
      createDependencyContainer({}),
      async () => {
        terminalCalls += 1;
        calls.push(`terminal:${terminalCalls}`);

        return terminalCalls;
      },
    );

    expect(result).toBe(1);
    expect(calls).toEqual([
      "retry:before",
      "attempt:before",
      "terminal:1",
      "attempt:after",
      "attempt:before",
      "terminal:2",
      "attempt:after",
      "retry:after",
    ]);
  });

  it("supports concurrent downstream traversals", async () => {
    const duplicate = defineMiddleware("duplicate", {
      handler: async (_context, next) => {
        const [first] = await Promise.all([next(), next()]);

        return first;
      },
    });
    let terminalCalls = 0;

    const result = await runMiddlewarePipeline(
      [duplicate],
      {},
      createDependencyContainer({}),
      async () => String(++terminalCalls),
    );

    expect(result).toBe("1");
  });

  it("propagates an entry failure without resolving downstream dependencies", async () => {
    const container = createDependencyContainer({});
    const failure = new Error("Middleware denied execution");
    const stop = defineMiddleware("stop", {
      handler: async () => { throw failure; },
    });
    const downstream = defineMiddleware("downstream", {
      dependencies: { service: dep<unknown>("unregistered") },
      handler: (_context, next) => next(),
    });
    const terminal = vi.fn(async () => "terminal");
    try {
      // The deliberately absent dependency would replace the denial if resolved eagerly.
      await expect(runMiddlewarePipeline([stop, downstream], {}, container, terminal)).rejects.toBe(failure);
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      await container.dispose();
    }
  });

  it("propagates an unwind failure after the terminal completes", async () => {
    const container = createDependencyContainer({});
    const failure = new Error("Middleware cleanup failed");
    const cleanup = defineMiddleware("cleanup", {
      handler: async (_context, next) => {
        await next();
        throw failure;
      },
    });
    const terminal = vi.fn(async () => "success");
    try {
      // An unwind failure is visible even when the terminal returns successfully.
      await expect(runMiddlewarePipeline([cleanup], {}, container, terminal)).rejects.toBe(failure);
      expect(terminal).toHaveBeenCalledOnce();
    } finally {
      await container.dispose();
    }
  });
});
