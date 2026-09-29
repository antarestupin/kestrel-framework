import { z } from "zod";
import {
  describe,
  expect,
  it,
} from "vitest";

import { defineRateLimit, seconds } from "../throttling/index.js";
import { defineWorker } from "./worker.js";

const externalApiLimit = defineRateLimit({
  id: "worker-definition-api",
  requests: 10,
  per: seconds(1),
});

describe("defineWorker throttling", () => {
  it("normalizes the simple case to the defer strategy", () => {
    const requirements = () => ({ admission: externalApiLimit });
    const worker = defineWorker({
      name: "simple-throttling",
      queue: "simple-throttling",
      input: z.string(),
      throttling: { requirements },
      handler: () => undefined,
    });

    expect(worker.throttling).toEqual({
      requirements,
      buffering: {
        strategy: "defer",
        fallbackDelayMs: 1_000,
      },
    });
  });

  it("normalizes bounded hold defaults", () => {
    const worker = defineWorker({
      name: "held-throttling",
      queue: "held-throttling",
      input: z.string(),
      throttling: {
        requirements: () => ({ admission: externalApiLimit }),
        buffering: { strategy: "hold", maxBlockedJobs: 3 },
      },
      handler: () => undefined,
    });

    expect(worker.throttling?.buffering).toEqual({
      strategy: "hold",
      maxBlockedJobs: 3,
      maxHoldMs: 30_000,
      fallbackDelayMs: 1_000,
    });
  });

  it.each([
    [{ strategy: "defer", fallbackDelayMs: 0 }, "fallbackDelayMs"],
    [{ strategy: "hold", maxHoldMs: Number.POSITIVE_INFINITY }, "maxHoldMs"],
    [{ strategy: "hold", maxBlockedJobs: 1.5 }, "maxBlockedJobs"],
  ] as const)("rejects invalid buffering options", (buffering, message) => {
    expect(() => defineWorker({
      name: "invalid-throttling",
      queue: "invalid-throttling",
      input: z.string(),
      throttling: {
        requirements: () => ({ admission: externalApiLimit }),
        buffering,
      },
      handler: () => undefined,
    })).toThrow(message);
  });
});
