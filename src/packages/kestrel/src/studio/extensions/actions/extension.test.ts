import Fastify from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { z } from "zod";

import {
  defineAction,
  defineActionMiddleware,
} from "../../../actions/index.js";
import { dep } from "../../../di/index.js";
import {
  AsyncLocalObserverContext,
  NoopObservationRecorder,
  ScopedObserver,
  type ObservationEvent,
} from "../../../observability/index.js";
import type { AnyAction } from "../../../utils/definitions.js";
import type { ActionsStudioExtensionOptions } from "./extension.js";
import { App, executionCompletedEvent } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import { Studio } from "../../studio.js";
import { defineActionsDocumentationExtension } from "./extension.js";

describe("actions documentation Studio extension", () => {
  it("lists explicitly registered actions in name order", async () => {
    const server = Fastify();
    onTestFinished(() => server.close());
    const extension = defineActionsDocumentationExtension([
      {
        name: "user.list",
        description: "List users.",
        middleware: [],
      },
      {
        name: "user.create",
        middleware: [{ name: "database.transaction" }],
      },
    ]);
    const studio = new Studio({ extensions: [extension] });
    const app = new App({});
    onTestFinished(() => app.dispose());
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/actions-documentation/actions",
    });

    expect(response.statusCode).toBe(200);
    expect(studio.getManifest().extensions[0]).toMatchObject({
      title: "Actions",
      description: "Browse the business operations exposed by the application.",
      pages: [{ title: "Actions", description: "Action contracts registered with Studio." }],
    });
    expect((await studio.defineHttpControllers()).slice(1).map(({ description }) => description)).toEqual([
      "List actions documented by Studio.",
      "Execute one JSON-compatible action from the Studio catalog.",
    ]);
    expect(response.json()).toEqual({
      executionPath:
        "/_studio/api/extensions/actions-documentation/actions/execute",
      actions: [
        {
          name: "user.create",
          execution: { enabled: false, reason: "Only documentation metadata was registered for this action." },
          middleware: ["database.transaction"],
        },
        {
          name: "user.list",
          execution: { enabled: false, reason: "Only documentation metadata was registered for this action." },
          description: "List users.",
          middleware: [],
        },
      ],
    });

    await server.close();
    await app.dispose();
  });

  it("rejects duplicate action names", () => {
    expect(() =>
      defineActionsDocumentationExtension([
        { name: "example.run", middleware: [] },
        { name: "example.run", middleware: [] },
      ]),
    ).toThrow('Action "example.run" is registered in Studio more than once.');
  });
});

/** Real controller injection exercises validation, runner binding and owned scope disposal. */
async function createExecutionTest(
  actions: readonly AnyAction[],
  options: ActionsStudioExtensionOptions = {},
) {
  const server = Fastify();
  const app = new App({});
  onTestFinished(async () => {
    try {
      await server.close();
    } finally {
      await app.dispose();
    }
  });
  const studio = new Studio({
    basePath: "/dev/tools",
    extensions: [defineActionsDocumentationExtension(actions, options)],
  });
  const manager = new HttpControllerManager(app, server, { observe: false });
  for (const controller of await studio.defineHttpControllers())
    manager.register(controller);
  server.addHook("onReady", () => app.start());
  const root = "/dev/tools/api/extensions/actions-documentation/actions";
  return {
    app,
    server,
    catalog: async () =>
      (await server.inject({ method: "GET", url: root })).json(),
    run: (name: string, input: unknown = null) =>
      server.inject({
        method: "POST",
        url: `${root}/execute`,
        payload: { name, input },
      }),
  };
}

describe("Studio action execution", () => {
  it("generates a tuple example when the configured examples omit a prototype-named action", async () => {
    const action = defineAction({
      name: "constructor",
      input: z.tuple([z.string(), z.number()]),
      output: z.string(),
      handler: ([name, count]) => `${name}:${count}`,
    });
    const http = await createExecutionTest([action], { examples: {} });
    const catalog = await http.catalog();
    expect(catalog.actions[0].execution).toMatchObject({
      enabled: true,
      noInput: false,
      examples: [{ name: "Generated example", input: ["example", 1] }],
    });
    const response = await http.run(action.name, catalog.actions[0].execution.examples[0].input);
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({ available: true, value: "example:1" });
  });

  it("returns the action failure and its execution id when a thrown object cannot be converted to text", async () => {
    const action = defineAction({
      name: "unprintable.failure",
      handler: () => { throw Object.create(null); },
    });
    const http = await createExecutionTest([action]);
    const response = await http.run(action.name);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      outcome: "failure",
      executionId: expect.any(String),
      message: "The thrown value could not be converted to a string.",
    });
  });

  it("rejects invalid configured examples even beside valid ones", () => {
    const action = defineAction({ name: "validate.example", input: z.unknown(), handler: () => null });
    expect(() => defineActionsDocumentationExtension([action], {
      examples: {
        [action.name]: [
          { name: "Valid", input: 1 },
          { name: "Invalid", input: Infinity },
        ],
      },
    })).toThrow('Studio examples for "validate.example" must contain JSON values.');
  });

  it("publishes the reason an impossible input schema cannot run", async () => {
    const handler = vi.fn(() => null);
    const action = defineAction({ name: "impossible", input: z.never(), handler });
    const http = await createExecutionTest([action]);
    const message = "This action input does not accept any value.";
    expect((await http.catalog()).actions[0].execution).toEqual({ enabled: false, reason: message });
    const response = await http.run(action.name);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ message });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs by default with scoped dependencies, middleware and exactly one async transform per boundary", async () => {
    const transform = vi.fn(async (value: string) => Number(value));
    const output = vi.fn(async (value: number) => ({ value }));
    const middleware = vi.fn();
    const dispose = vi.fn();
    const action = defineAction({
      name: "math.increment",
      input: z.string().transform(transform),
      output: z.number().transform(output),
      validation: { input: "async", output: "async" },
      dependencies: { counter: dep<{ increment: number }>("counter") },
      middleware: [
        defineActionMiddleware("record", {
          handler: async ({ input }, next) => {
            middleware(input);
            return next();
          },
        }),
      ],
      handler: (input, { counter }) => input + counter.increment,
    });
    const http = await createExecutionTest([action], {
      examples: { [action.name]: [{ name: "Two", input: "2" }] },
    });
    http.app.container.registerFactory("counter", () => ({ increment: 1 }), {
      lifetime: "scoped",
      dispose,
    });
    const catalog = await http.catalog();
    expect(catalog.executionPath).toBe(
      "/dev/tools/api/extensions/actions-documentation/actions/execute",
    );
    expect(catalog.actions[0].execution).toMatchObject({
      enabled: true,
      inputSchema: { type: "string" },
      examples: [{ name: "Two", input: "2" }],
    });
    expect(transform).not.toHaveBeenCalled();
    const response = await http.run(action.name, "2");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "success",
      executionId: expect.any(String),
      durationMs: expect.any(Number),
      result: { available: true, value: { value: 3 } },
    });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(middleware).toHaveBeenCalledWith(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps unsupported and excluded actions visible but rejects direct execution requests", async () => {
    const handler = vi.fn(() => null);
    const instance = defineAction({
      name: "instance",
      input: z.object({ date: z.instanceof(Date) }),
      handler,
    });
    const excluded = defineAction({ name: "excluded", handler });
    const http = await createExecutionTest([instance, excluded], {
      exclude: ["excluded"],
    });
    const catalog = await http.catalog();
    expect(
      catalog.actions.every(
        (action: { execution: { enabled: boolean } }) =>
          !action.execution.enabled,
      ),
    ).toBe(true);
    expect(
      catalog.actions.find(
        (action: { name: string }) => action.name === "instance",
      ).execution.reason,
    ).toContain("class instance");
    expect(
      (await http.run("instance", { date: "2026-01-01" })).statusCode,
    ).toBe(403);
    const denied = await http.run("excluded");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ message: "This action is excluded from Studio execution." });
    const missing = await http.run("missing");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ message: "The action is not registered in Studio." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports null input and enforces the global execution switch", async () => {
    const handler = vi.fn(() => null);
    const action = defineAction({ name: "ping", handler });
    const enabled = await createExecutionTest([action]);
    expect((await enabled.catalog()).actions[0].execution.noInput).toBe(true);
    expect((await enabled.run("ping")).json()).toMatchObject({
      outcome: "success",
      result: { available: true, value: null },
    });
    const disabled = await createExecutionTest([action], { execution: false });
    const response = await disabled.run("ping");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ message: "Action execution is disabled in Studio." });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports input field paths without invoking the handler, and distinguishes output and handler failures", async () => {
    const handler = vi.fn(() => null);
    const input = defineAction({
      name: "input",
      input: z.object({ count: z.number().positive() }),
      handler,
    });
    const output = defineAction({
      name: "output",
      output: z.number().positive(),
      handler: () => -1,
    });
    const throwing = defineAction({
      name: "throw",
      handler: () => {
        throw new Error("Business operation failed.");
      },
    });
    const http = await createExecutionTest([input, output, throwing]);
    const outcomes: string[] = [];
    http.app.eventBus.listen(
      executionCompletedEvent,
      (event) => {
        outcomes.push(event.outcome);
      },
      { scope: "descendants" },
    );
    const invalid = await http.run("input", { count: -1 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      outcome: "failure",
      message: "The action input is invalid.",
      issues: [{ path: ["count"], message: expect.any(String) }],
    });
    expect(handler).not.toHaveBeenCalled();
    const invalidOutput = await http.run("output");
    expect(invalidOutput.statusCode).toBe(500);
    expect(invalidOutput.json()).toMatchObject({ message: "Action validation failed during execution." });
    const failed = await http.run("throw");
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({
      outcome: "failure",
      message: "Business operation failed.",
    });
    expect(outcomes).toEqual(["failure", "failure", "failure"]);
  });

  it("preserves numeric issue locations and converts symbol issue keys for JSON", async () => {
    const action = defineAction({
      name: "issue.path",
      input: z.unknown().superRefine((_value, context) => {
        context.addIssue({ code: "custom", path: [Symbol("column"), 2], message: "Invalid cell." });
      }),
      handler: () => null,
    });
    const http = await createExecutionTest([action]);
    const response = await http.run(action.name);
    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toEqual([{ path: ["Symbol(column)", 2], message: "Invalid cell." }]);
  });

  it("serializes action results with native JSON semantics and invokes hooks only once", async () => {
    const getter = vi.fn(() => "visible");
    const toJSON = vi.fn(() => ({ converted: true }));
    class Result {
      value = 42;
    }
    const cases = [
      {
        value: new Date("2026-01-01T00:00:00.000Z"),
        expected: "2026-01-01T00:00:00.000Z",
      },
      { value: new Result(), expected: { value: 42 } },
      { value: { toJSON }, expected: { converted: true } },
      {
        value: Object.defineProperty({}, "value", {
          enumerable: true,
          get: getter,
        }),
        expected: { value: "visible" },
      },
      { value: Object.assign([1], { extra: "omitted" }), expected: [1] },
      { value: { omitted: undefined, kept: true }, expected: { kept: true } },
      { value: [undefined, NaN, Infinity], expected: [null, null, null] },
      { value: new Map([["key", "value"]]), expected: {} },
      { value: NaN, expected: null },
    ];
    const handlers = cases.map(({ value }) => vi.fn(() => value));
    const actions = handlers.map((handler, index) =>
      defineAction({ name: `result.${index}`, output: z.unknown(), handler }),
    );
    const http = await createExecutionTest(actions);
    for (const [index, action] of actions.entries()) {
      const response = await http.run(action.name);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        outcome: "success",
        result: { available: true, value: cases[index]!.expected },
      });
    }
    handlers.forEach((handler) => expect(handler).toHaveBeenCalledTimes(1));
    expect(getter).toHaveBeenCalledTimes(1);
    expect(toJSON).toHaveBeenCalledTimes(1);
  });

  it("keeps execution successful when JSON serialization fails or produces no value", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const throwingToJSON = vi.fn(() => {
      throw new Error("Cannot serialize");
    });
    const values = [
      BigInt(1),
      undefined,
      cycle,
      { toJSON: throwingToJSON },
      () => null,
      Symbol("result"),
    ];
    const handlers = values.map((value) => vi.fn(() => value));
    const actions = handlers.map((handler, index) =>
      defineAction({ name: `result.${index}`, output: z.unknown(), handler }),
    );
    const http = await createExecutionTest(actions);
    for (const [index, action] of actions.entries()) {
      const response = await http.run(action.name);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        outcome: "success",
        result: {
          available: false,
          reason: [1, 4, 5].includes(index)
            ? "The action succeeded, but its result has no JSON representation."
            : "The action succeeded, but its result could not be serialized.",
        },
      });
    }
    handlers.forEach((handler) => expect(handler).toHaveBeenCalledTimes(1));
    expect(throwingToJSON).toHaveBeenCalledTimes(1);
  });

  it("records only action runs with their correlation ID, including failures and ambient observations", async () => {
    const events: ObservationEvent[] = [];
    class Recorder extends NoopObservationRecorder {
      override enqueue(event: ObservationEvent) {
        events.push(event);
      }
    }
    const context = new AsyncLocalObserverContext();
    let time = 100;
    const action = defineAction({
      name: "observed",
      handler: () => {
        expect(context.get()).toBeDefined();
        time += 13;
        throw new Error("Observed failure");
      },
    });
    const success = defineAction({
      name: "observed.success",
      handler: () => {
        expect(context.get()).toBeDefined();
        time += 7;
        return null;
      },
    });
    const http = await createExecutionTest([action, success], { observability: true });
    const recorder = new Recorder();
    http.app.container.registerValue("observerContext", context);
    http.app.container.registerFactory(
      "observer",
      ({ executionId }: { executionId: string }) =>
        new ScopedObserver(executionId, recorder),
      { lifetime: "scoped" },
    );
    expect((await http.catalog()).observability.dataPath).toContain(
      "/dev/tools/",
    );
    expect(events).toEqual([]);
    const logs: unknown[] = [];
    http.app.eventBus.listen(executionCompletedEvent, ({ context }) => {
      logs.push(context.toRecord("log"));
    }, { scope: "descendants" });
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    onTestFinished(() => { clock.mockRestore(); });
    const response = await http.run(action.name);
    expect(response.json().durationMs).toBe(13);
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "execution.completed",
    ]);
    expect(
      events.every(
        (event) => event.executionId === response.json().executionId,
      ),
    ).toBe(true);
    expect(events[1]).toMatchObject({
      outcome: "failure",
      durationMs: 13,
      data: {
        operation: action.name, transport: "direct",
        error: { name: "Error", message: "Observed failure" },
      },
    });
    const completed = await http.run(success.name);
    expect(completed.json().durationMs).toBe(7);
    expect(events[3]).toMatchObject({
      outcome: "success", durationMs: 7,
      data: { operation: success.name, transport: "direct" },
    });
    expect(events[3]?.data).not.toHaveProperty("error");
    expect(logs).toEqual([
      expect.objectContaining({ operation: action.name, transport: "direct" }),
      expect.objectContaining({ operation: success.name, transport: "direct" }),
    ]);
    expect(context.get()).toBeUndefined();
  });
});
