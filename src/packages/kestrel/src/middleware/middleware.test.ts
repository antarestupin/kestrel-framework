import { describe, expect, it } from "vitest";

import { createDependencyContainer } from "../di/index.js";
import {
  defineMiddleware,
  runMiddlewarePipeline,
} from "./index.js";

describe("middleware pipeline", () => {
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
});
