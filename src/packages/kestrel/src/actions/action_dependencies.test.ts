import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { createDependencyContainer, dep, fromConfig } from "../di/index.js";
import { defineAction, defineActionMiddleware, mapActionInput } from "./index.js";

describe("action dependencies", () => {
  it("shares scoped resources across nested calls and disposes them once per execution", async () => {
    const resource = dep<object>("resource");
    const dispose = vi.fn();
    const create = vi.fn(() => ({}));
    const child = defineAction({
      name: "nested.child",
      output: z.custom<object>(),
      dependencies: { resource },
      handler: (_input, { resource }) => resource,
    });
    const parent = defineAction({
      name: "nested.parent",
      output: z.custom<object>(),
      dependencies: { child, resource },
      handler: async (_input, { child, resource }) => {
        expect(await child.run(null)).toBe(resource);
        expect(await child.run(null)).toBe(resource);
        expect(dispose.mock.calls.some(([disposed]) => disposed === resource)).toBe(false);
        return resource;
      },
    });
    const app = new App({});
    app.container.registerFactory("resource", create, { lifetime: "scoped", dispose });

    try {
      const first = await app.get(parent).run(null);
      const second = await app.get(parent).run(null);
      expect(first).not.toBe(second);
      expect(create).toHaveBeenCalledTimes(2);
      expect(dispose.mock.calls).toEqual([[first], [second]]);
    } finally {
      await app.dispose();
    }
  });

  it("binds lazily without registering or running the referenced action", async () => {
    const handler = vi.fn(() => null);
    const child = defineAction({
      name: "lazy.child",
      dependencies: { missing: dep<string>("missing") },
      handler,
    });
    const parent = defineAction({
      name: "lazy.parent",
      dependencies: { child },
      handler: () => null,
    });
    const container = createDependencyContainer({});
    try {
      const runner = container.resolve(child);
      await expect(container.resolve(parent).run(null)).resolves.toBeNull();
      expect(handler).not.toHaveBeenCalled();
      await expect(runner.run(null)).rejects.toThrow(/Could not resolve 'missing'/);
    } finally {
      await container.dispose();
    }
  });

  it("infers transformed contracts and runs derived actions through a dependency chain", async () => {
    const source = defineAction({
      name: "derived.source",
      input: z.string().transform(async (value) => Number(value)),
      output: z.number().transform(async (value) => String(value)),
      validation: { input: "async", output: "async" },
      dependencies: { factor: fromConfig((config: { factor: number }) => config.factor) },
      handler: (value, { factor }) => value * factor,
    });
    const derived = source.derive(mapActionInput(
      z.object({ text: z.string() }),
      ({ text }) => text,
    ));
    const parent = defineAction({
      name: "derived.parent",
      input: derived.inputSchema,
      output: z.string(),
      dependencies: { derived },
      handler: (input, { derived }) => {
        // The runner accepts schema input and returns parsed schema output.
        expectTypeOf(derived.run).parameter(0).toEqualTypeOf<{ text: string }>();
        expectTypeOf(derived.run).returns.toEqualTypeOf<Promise<string>>();
        return derived.run(input);
      },
    });
    const grandparent = defineAction({
      name: "derived.grandparent",
      input: parent.inputSchema,
      output: z.string(),
      dependencies: { parent },
      handler: (input, { parent }) => parent.run(input),
    });
    const app = new App({ factor: 3 });
    try {
      await expect(app.get(grandparent).run({ text: "4" })).resolves.toBe("12");
      await expect(app.get(source).run("4")).resolves.toBe("12");
    } finally {
      await app.dispose();
    }
  });

  it.each(["success", "input", "output", "handler"] as const)(
    "preserves nested validation, middleware and disposal on %s",
    async (scenario) => {
      const events: string[] = [];
      const failure = new Error("Child failed");
      const dispose = vi.fn();
      const middleware = defineActionMiddleware("nested.trace", {
        handler: async (_context, next) => {
          events.push("before");
          try {
            const result = await next();
            events.push("after");
            return result;
          } catch (error) {
            events.push("error");
            throw error;
          }
        },
      });
      const child = defineAction({
        name: "validated.child",
        input: z.number().positive(),
        output: z.number().positive(),
        middleware: [middleware],
        handler: (value) => {
          events.push("handler");
          if (scenario === "handler") throw failure;
          return scenario === "output" ? -1 : value;
        },
      });
      const parent = defineAction({
        name: "validated.parent",
        input: z.number(),
        output: z.number(),
        dependencies: { child, resource: dep<object>("resource") },
        handler: (value, { child }) => child.run(value),
      });
      const app = new App({});
      app.container.registerFactory("resource", () => ({}), { lifetime: "scoped", dispose });
      try {
        const result = app.get(parent).run(scenario === "input" ? -1 : 1);
        if (scenario === "success") {
          await expect(result).resolves.toBe(1);
          expect(events).toEqual(["before", "handler", "after"]);
        } else {
          if (scenario === "handler") {
            await expect(result).rejects.toBe(failure);
          } else {
            await expect(result).rejects.toBeInstanceOf(z.ZodError);
          }
          expect(events).toEqual(scenario === "input" ? [] : ["before", "handler", "error"]);
        }
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        await app.dispose();
      }
    },
  );
});
