import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { databaseTransaction } from "../db/index.js";
import { dep, fromConfig } from "../di/index.js";
import {
  defineAction,
  defineActionMiddleware,
  mapActionInput,
} from "./index.js";

// A successful middleware result must remain valid for every action output.
defineActionMiddleware("invalid.return-type", {
  // @ts-expect-error A middleware cannot replace the action output with a string.
  handler: async () => "invalid",
});

class Multiplier {
  public constructor(
    private readonly dependencies: { factor: number },
  ) {}

  public apply(value: number): number {
    return value * this.dependencies.factor;
  }
}

describe("actions", () => {
  it.each(["input", "output"] as const)("requires async opt-in for the %s boundary", async (boundary) => {
    const transform = vi.fn(async (value: string) => value.toUpperCase());
    const schema = z.string().transform(transform);
    const app = new App({});
    const options = {
      name: "explicit.async",
      input: boundary === "input" ? schema : z.string(),
      output: boundary === "output" ? schema : z.string(),
      handler: async (value: string) => value,
    };
    try {
      await expect(app.get(defineAction(options)).run("value"))
        .rejects.toThrow(/Promise/);
      expect(transform).toHaveBeenCalledTimes(1);
      const action = defineAction({ ...options, validation: { [boundary]: "async" } });
      await expect(app.get(action).run("value")).resolves.toBe("VALUE");
      expect(transform).toHaveBeenCalledTimes(2);
      expect(action.validation[boundary === "input" ? "output" : "input"]).toBe("sync");
    } finally {
      await app.dispose();
    }
  });

  it("retains source policies across mapped inputs and supports an async replacement", async () => {
    const source = defineAction({
      name: "mapped.async",
      input: z.string().transform(async (value) => value.length),
      output: z.number().transform(async (value) => value * 2),
      validation: { input: "async", output: "async" },
      handler: (value) => value,
    });
    const mapped = source.derive(mapActionInput(z.object({ text: z.string() }), ({ text }) => text));
    const asyncMapped = source.derive(mapActionInput(
      z.string().transform(async (value) => value.trim()),
      (value) => value,
      "async",
    ));
    const app = new App({});
    try {
      expect(mapped.validation).toEqual({ input: "sync", output: "async" });
      await expect(app.get(mapped).run({ text: "test" })).resolves.toBe(8);
      await expect(app.get(asyncMapped).run(" test ")).resolves.toBe(8);
    } finally {
      await app.dispose();
    }
  });

  it("uses null contracts when input and output are omitted", async () => {
    const action = defineAction({
      name: "empty.run",
      handler: (input) => input,
    });
    const inputOnlyAction = defineAction({
      name: "input-only.run",
      input: z.string(),
      handler: () => null,
    });
    const outputOnlyAction = defineAction({
      name: "output-only.run",
      output: z.string(),
      handler: () => "result",
    });
    const app = new App({});

    const result = app.get(action).run(null);

    await expect(result).resolves.toBeNull();
    await expect(
      app.get(inputOnlyAction).run("input"),
    ).resolves.toBeNull();
    await expect(
      app.get(outputOnlyAction).run(null),
    ).resolves.toBe("result");
    expectTypeOf(result).toEqualTypeOf<Promise<null>>();
    expect(action.inputSchema.parse(null)).toBeNull();
    expect(action.outputSchema.parse(null)).toBeNull();

    await app.dispose();
  });

  it("validates and transforms input and output around the handler", async () => {
    const handler = vi.fn((value: number) =>
      String(value * 2),
    );
    const action = defineAction({
      name: "number.double",
      input: z.string().transform(Number),
      output: z.coerce.number().int(),
      handler,
    });
    const app = new App({});

    const result = app.get(action).run("4");

    await expect(result).resolves.toBe(8);
    expect(handler).toHaveBeenCalledExactlyOnceWith(4, {});
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();

    await app.dispose();
  });

  it("resolves declared dependencies for the handler", async () => {
    const action = defineAction({
      name: "number.multiply",
      input: z.number(),
      output: z.number(),
      dependencies: { multiplier: Multiplier },
      handler: (value, { multiplier }) =>
        multiplier.apply(value),
    });
    const app = new App({});

    app.container.registerValue("factor", 3);

    await expect(app.get(action).run(4)).resolves.toBe(12);

    await app.dispose();
  });

  it("supports configuration dependencies from the bound application", async () => {
    interface TestConfig {
      base: number;
    }

    const action = defineAction({
      name: "number.add-base",
      input: z.number(),
      output: z.number(),
      dependencies: {
        base: fromConfig(
          (config: TestConfig) => config.base,
        ),
      },
      handler: (value, { base }) => value + base,
    });
    const app = new App<TestConfig>({ base: 2 });

    await expect(app.get(action).run(3)).resolves.toBe(5);

    await app.dispose();
  });

  it("does not call the handler when input validation fails", async () => {
    const handler = vi.fn();
    const action = defineAction({
      name: "number.positive",
      input: z.number().positive(),
      output: z.number(),
      handler,
    });
    const app = new App({});

    await expect(app.get(action).run(-1)).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(handler).not.toHaveBeenCalled();

    await app.dispose();
  });

  it("validates handler output", async () => {
    const action = defineAction({
      name: "number.invalid-output",
      input: z.number(),
      output: z.string(),
      // The cast simulates an implementation returning an invalid runtime
      // value despite its compile-time contract.
      handler: () => 1 as unknown as string,
    });
    const app = new App({});

    await expect(app.get(action).run(1)).rejects.toBeInstanceOf(
      z.ZodError,
    );

    await app.dispose();
  });

  it("runs action middleware around the handler and output validation", async () => {
    let transactionActive = false;
    const transaction = vi.fn(
      async <Result>(
        operation: () => Promise<Result>,
      ): Promise<Result> => {
        transactionActive = true;

        try {
          return await operation();
        } finally {
          transactionActive = false;
        }
      },
    );
    const action = defineAction({
      name: "number.transactional",
      input: z.number(),
      output: z.number().refine(() => transactionActive),
      middleware: [databaseTransaction],
      handler: (value) => value * 2,
    });
    const app = new App({});

    app.container.registerValue("databaseManager", {
      transaction,
    });

    await expect(app.get(action).run(4)).resolves.toBe(8);
    expect(transaction).toHaveBeenCalledOnce();

    await app.dispose();
  });

  it("runs named middleware in declaration order with its own dependencies", async () => {
    const events: string[] = [];
    const first = defineActionMiddleware("test.first", {
      dependencies: {
        label: dep<string>("label"),
      },
      handler: async ({ deps }, next) => {
        events.push(`before:${deps.label}`);
        const result = await next();

        events.push(`after:${deps.label}`);

        return result;
      },
    });
    const second = defineActionMiddleware("test.second", {
      handler: async (_context, next) => {
        events.push("before:second");
        const result = await next();

        events.push("after:second");

        return result;
      },
    });
    const action = defineAction({
      name: "number.middleware-order",
      input: z.number(),
      output: z.number(),
      middleware: [first, second],
      handler: (value) => {
        events.push("handler");

        return value * 2;
      },
    });
    const app = new App({});

    app.container.registerValue("label", "first");

    await expect(app.get(action).run(4)).resolves.toBe(8);
    expect(events).toEqual([
      "before:first",
      "before:second",
      "handler",
      "after:second",
      "after:first",
    ]);

    await app.dispose();
  });

  it("replays the action suffix when middleware calls next repeatedly", async () => {
    const middleware = defineActionMiddleware("test.double-next", {
      handler: async (_context, next) => {
        await next();

        return next();
      },
    });
    const handler = vi.fn((value: number) => value);
    const action = defineAction({
      name: "number.double-next",
      input: z.number(),
      output: z.number(),
      middleware: [middleware],
      handler,
    });
    const app = new App({});

    await expect(app.get(action).run(1)).resolves.toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);

    await app.dispose();
  });

  it("disposes action-scoped dependencies after every run", async () => {
    const dispose = vi.fn();
    const action = defineAction({
      name: "scope.read",
      input: z.undefined(),
      output: z.custom<object>((value) => typeof value === "object"),
      dependencies: {
        resource: dep<object>("resource"),
      },
      handler: (_input, { resource }) => resource,
    });
    const app = new App({});

    app.container.registerFactory("resource", () => ({}), {
      lifetime: "scoped",
      dispose,
    });

    await app.get(action).run(undefined);

    expect(dispose).toHaveBeenCalledOnce();

    await app.dispose();
  });

  it("derives an action with a mapped input without changing its source", async () => {
    const handler = vi.fn(
      (input: { value: number }) => input.value * 2,
    );
    const sourceAction = defineAction({
      name: "number.double-mapped",
      input: z.object({
        value: z.coerce.number().positive(),
      }),
      output: z.number(),
      description: "Double a positive number.",
      handler,
    });
    const derivedAction = sourceAction.derive(
      mapActionInput(
        z.object({ text: z.string() }),
        ({ text }) => ({ value: text }),
      ),
    );
    const app = new App({});

    const result = app
      .get(derivedAction)
      .run({ text: "4" });

    await expect(result).resolves.toBe(8);
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      { value: 4 },
      {},
    );
    expect(derivedAction.name).toBe(sourceAction.name);
    expect(derivedAction.description).toBe(
      sourceAction.description,
    );
    expect(derivedAction.outputSchema).toBe(
      sourceAction.outputSchema,
    );
    expect(derivedAction.dependencies).toBe(
      sourceAction.dependencies,
    );
    expect(derivedAction.middleware).toBe(sourceAction.middleware);
    expect(derivedAction.inputSchema).not.toBe(
      sourceAction.inputSchema,
    );
    expect(Object.keys(sourceAction.inputSchema.shape))
      .toEqual(["value"]);
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();

    await app.dispose();
  });

  it("validates mapped values with the source input schema", async () => {
    const handler = vi.fn((value: number) => value);
    const sourceAction = defineAction({
      name: "number.mapped-positive",
      input: z.number().positive(),
      output: z.number(),
      handler,
    });
    const derivedAction = sourceAction.derive(
      mapActionInput(
        z.object({ value: z.number() }),
        ({ value }) => value,
      ),
    );
    const app = new App({});

    await expect(
      app.get(derivedAction).run({ value: -1 }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(handler).not.toHaveBeenCalled();

    await app.dispose();
  });
});
