import { z } from "zod";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AggregatedResultBuilder,
  collectAggregatedResult,
  createAggregatedResult,
  createAggregatedResultSchema,
  getAggregatedResultStatus,
  mergeAggregatedResults,
  runAggregatedResult,
  type AggregatedResult,
  type AggregatedResultOutcome,
} from "./index.js";

describe("AggregatedResult", () => {
  it.each([
    { results: 0, errors: 0, status: "success" },
    { results: 2, errors: 0, status: "success" },
    { results: 0, errors: 2, status: "error" },
    { results: 2, errors: 1, status: "partial" },
  ] as const)(
    "derives $status from $results results and $errors errors",
    ({ results, errors, status }) => {
      expect(getAggregatedResultStatus(results, errors)).toBe(status);
    },
  );

  it("creates a stable aggregate snapshot with global data", () => {
    const results = [{ key: "first", result: 42 }];
    const errors = [{ key: "second", error: "unavailable" }];

    const aggregated = createAggregatedResult({
      results,
      errors,
      data: { durationMs: 12 },
    });

    results.push({ key: "later", result: 24 });
    errors.length = 0;

    expect(aggregated).toEqual({
      status: "partial",
      results: [{ key: "first", result: 42 }],
      errors: [{ key: "second", error: "unavailable" }],
      data: { durationMs: 12 },
    });
  });

  it("considers an empty aggregate successful", () => {
    expect(createAggregatedResult()).toEqual({
      status: "success",
      results: [],
      errors: [],
      data: undefined,
    });
  });

  it("builds incrementally and keeps previous snapshots stable", () => {
    const builder = new AggregatedResultBuilder<string, number, Error>();
    const failure = new Error("failed");

    builder.addAll([
      { key: "first", status: "success", result: 1 },
      { key: "second", status: "error", error: failure },
    ]);

    expect(builder.resultCount).toBe(1);
    expect(builder.errorCount).toBe(1);
    expect(builder.status).toBe("partial");

    const firstSnapshot = builder.build();
    builder.addResult("third", 3);

    expect(firstSnapshot.results).toEqual([
      { key: "first", result: 1 },
    ]);
    expect(builder.build({ source: "import" })).toEqual({
      status: "partial",
      results: [
        { key: "first", result: 1 },
        { key: "third", result: 3 },
      ],
      errors: [{ key: "second", error: failure }],
      data: { source: "import" },
    });
  });

  it("collects asynchronous outcomes", async () => {
    async function *outcomes(): AsyncIterable<
      AggregatedResultOutcome<string, number, string>
    > {
      yield { key: "first", status: "success", result: 1 };
      await Promise.resolve();
      yield { key: "second", status: "error", error: "failed" };
    }

    await expect(collectAggregatedResult(
      outcomes(),
      { cursor: "next" },
    )).resolves.toEqual({
      status: "partial",
      results: [{ key: "first", result: 1 }],
      errors: [{ key: "second", error: "failed" }],
      data: { cursor: "next" },
    });
  });

  it("runs a regular function with a builder and returned global data", async () => {
    const aggregated = await runAggregatedResult<
      string,
      number,
      string,
      { processed: number }
    >(async (builder) => {
      builder.addResult("first", 1);
      await Promise.resolve();
      builder.addError("second", "failed");

      return { processed: 2 };
    });

    expect(aggregated).toEqual({
      status: "partial",
      results: [{ key: "first", result: 1 }],
      errors: [{ key: "second", error: "failed" }],
      data: { processed: 2 },
    });
  });

  it("collects synchronous generator yields and its return value", async () => {
    const aggregated = await runAggregatedResult<
      string,
      number,
      string,
      { processed: number }
    >(function *produce() {
      yield { key: "first", status: "success", result: 1 };
      yield { key: "second", status: "error", error: "failed" };

      return { processed: 2 };
    });

    expect(aggregated).toEqual({
      status: "partial",
      results: [{ key: "first", result: 1 }],
      errors: [{ key: "second", error: "failed" }],
      data: { processed: 2 },
    });
  });

  it("collects asynchronous generator yields and its return value", async () => {
    const aggregated = await runAggregatedResult<
      string,
      number,
      string,
      string
    >(async function *produce() {
      yield { key: "first", status: "success", result: 1 };
      await Promise.resolve();
      yield { key: "second", status: "success", result: 2 };

      return "next-page";
    });

    expect(aggregated).toEqual({
      status: "success",
      results: [
        { key: "first", result: 1 },
        { key: "second", result: 2 },
      ],
      errors: [],
      data: "next-page",
    });
  });

  it("supports a function with no outcomes or global data", async () => {
    const aggregated = await runAggregatedResult<string, number, string>(
      () => {},
    );

    expect(aggregated).toEqual({
      status: "success",
      results: [],
      errors: [],
      data: undefined,
    });
  });

  it("keeps iterable global data returned by a regular function", async () => {
    const aggregated = await runAggregatedResult<
      string,
      number,
      string,
      readonly string[]
    >(() => ["first", "second"]);

    expect(aggregated.data).toEqual(["first", "second"]);
  });

  it("propagates generator failures", async () => {
    const failure = new Error("stream failed");

    await expect(runAggregatedResult<string, number, string>(
      async function *produce() {
        yield { key: "first", status: "success", result: 1 };
        throw failure;
      },
    )).rejects.toBe(failure);
  });

  it("awaits a callback for every generator yield", async () => {
    const processed: string[] = [];
    const aggregated = await runAggregatedResult<
      string,
      number,
      string
    >(
      async function *produce() {
        yield { key: "first", status: "success", result: 1 };
        expect(processed).toEqual(["first"]);
        yield { key: "second", status: "error", error: "failed" };
      },
      {
        onYield: async (outcome) => {
          await Promise.resolve();
          processed.push(outcome.key);
        },
      },
    );

    expect(processed).toEqual(["first", "second"]);
    expect(aggregated.status).toBe("partial");
  });

  it("closes the generator when its yield callback fails", async () => {
    const failure = new Error("callback failed");
    const finalized = vi.fn();

    await expect(runAggregatedResult<string, number, string>(
      async function *produce() {
        try {
          yield { key: "first", status: "success", result: 1 };
        } finally {
          finalized();
        }
      },
      {
        onYield: () => {
          throw failure;
        },
      },
    )).rejects.toBe(failure);
    expect(finalized).toHaveBeenCalledOnce();
  });

  it("merges aggregates and replaces their global data", () => {
    const first = createAggregatedResult({
      results: [{ key: "first", result: 1 }],
      data: { page: 1 },
    });
    const second = createAggregatedResult({
      errors: [{ key: "second", error: "failed" }],
      data: { page: 2 },
    });

    expect(mergeAggregatedResults([first, second], {
      pages: 2,
    })).toEqual({
      status: "partial",
      results: [{ key: "first", result: 1 }],
      errors: [{ key: "second", error: "failed" }],
      data: { pages: 2 },
    });
  });

  it("generates a typed Zod schema for aggregate data", () => {
    const schema = createAggregatedResultSchema({
      key: z.string(),
      result: z.coerce.number(),
      error: z.object({ message: z.string() }),
      data: z.object({ durationMs: z.number() }),
    });
    const parsed: AggregatedResult<
      string,
      number,
      { message: string },
      { durationMs: number }
    > = schema.parse({
      status: "partial",
      results: [{ key: "first", result: "42" }],
      errors: [{ key: "second", error: { message: "failed" } }],
      data: { durationMs: 12 },
    });

    expect(parsed.results[0]?.result).toBe(42);
  });

  it("rejects a schema status inconsistent with the item collections", () => {
    const schema = createAggregatedResultSchema({
      key: z.string(),
      result: z.number(),
      error: z.string(),
    });
    const parsed = schema.safeParse({
      status: "success",
      results: [{ key: "first", result: 1 }],
      errors: [{ key: "second", error: "failed" }],
      data: undefined,
    });

    expect(parsed.success).toBe(false);

    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["status"],
        message: "Expected status \"partial\" from the aggregated results.",
      }));
    }
  });
});
