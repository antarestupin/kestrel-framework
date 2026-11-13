import Fastify, { type FastifyInstance } from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App, executionCompletedEvent } from "../app/index.js";
import { executionCompletedObservation, executionStartedObservation } from "../app/observations.js";
import { dep } from "../di/index.js";
import { errorHandlerDependency, type HttpRepresentableError } from "../errors/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import {
  AsyncLocalObserverContext,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import { executeHttpController } from "./controller_executor.js";
import {
  anonymousHttpAccess,
  body,
  defineActionHttpController,
  defineHttpAccessPolicy,
  defineHttpController,
  defineHttpMiddleware,
  get,
  HttpControllerManager,
  type HttpControllerManagerOptions,
  path,
  post,
  query,
} from "./index.js";

const servers = new Set<FastifyInstance>();
const apps = new Set<App<Record<string, never>>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  await Promise.all([...apps].map((app) => app.dispose()));
  servers.clear();
  apps.clear();
});

function createTestHttp(
  options: HttpControllerManagerOptions = {},
): {
  app: App<Record<string, never>>;
  manager: HttpControllerManager<Record<string, never>>;
  server: FastifyInstance;
} {
  // Bound a broken route's response independently from the test runner deadline.
  const server = Fastify({ handlerTimeout: 250 });
  const app = new App({});

  apps.add(app);
  servers.add(server);
  server.addHook("onReady", async () => app.start());
  const scopes = new Set<Awaited<ReturnType<typeof app.createExecutionScope>>>();
  const createExecutionScope = app.createExecutionScope.bind(app);
  vi.spyOn(app, "createExecutionScope").mockImplementation(async (id) => {
    const scope = await createExecutionScope(id);
    scopes.add(scope);
    void scope.whenDisposed.then(() => { scopes.delete(scope); });
    return scope;
  });
  server.addHook("onClose", async () => {
    await Promise.all([...scopes].map((scope) => scope.dispose()));
  });

  return {
    app,
    manager: new HttpControllerManager(app, server, options),
    server,
  };
}

describe("HttpControllerManager", () => {
  it("returns an opaque correlated response when creating the execution scope fails", async () => {
    const { app, manager, server } = createTestHttp({ executionIdHeader: "x-execution-id" });
    const id = "00000000-0000-4000-8000-000000000042";
    const privateFailure = new Error("secret scope factory connection details");
    const handler = vi.fn(() => "unreachable");
    vi.mocked(app.createExecutionScope).mockRejectedValueOnce(privateFailure).mockRejectedValueOnce(privateFailure);
    manager.register(defineHttpController({ route: get("/scope-failure"), handler }));

    for (const requestId of [id, "malformed-execution-id"]) {
      const response = await server.inject({ url: "/scope-failure", headers: { "x-execution-id": requestId } });
      const correlation = response.headers["x-execution-id"];
      expect(correlation).toEqual(requestId === id ? id : expect.stringMatching(/^[a-f0-9-]{36}$/u));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        statusCode: 500, error: "Internal Server Error", message: "An unexpected error occurred.", executionId: correlation,
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("binds GET input from the query when the route contains an escaped colon", async () => {
    const { manager, server } = createTestHttp();
    manager.register(defineHttpController({
      route: get("/jobs::status"),
      input: z.object({ status: z.string() }),
      handler: ({ input }) => input.status,
    }));

    // Fastify's doubled colon introduces literal route text, not a parameter.
    const response = await server.inject("/jobs:status?status=active");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("active");
  });

  it("reads only wire properties present in the request and uses defaults for missing values", async () => {
    const { manager, server } = createTestHttp();
    manager.register(defineHttpController({
      access: testHttpAccess, route: post("/optional-body"),
      input: z.object({ value: z.string().default("fallback") }),
      bindings: { value: body("constructor") },
      handler: ({ input }) => input.value,
    }));

    for (const payload of [{ other: true }, undefined]) {
      const response = await server.inject({ method: "POST", url: "/optional-body", ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(201);
      expect(response.body).toBe("fallback");
    }
    const jsonNull = await server.inject({
      method: "POST", url: "/optional-body", headers: { "content-type": "application/json" }, payload: "null",
    });
    expect(jsonNull.statusCode).toBe(201);
    expect(jsonNull.body).toBe("fallback");
    const explicit = await server.inject({ method: "POST", url: "/optional-body", payload: { constructor: "provided" } });
    expect(explicit.statusCode).toBe(201);
    expect(explicit.body).toBe("provided");
  });

  it("uses a field's unnamed path binding and infers prototype-like query fields normally", async () => {
    const { manager, server } = createTestHttp();
    manager.register(defineHttpController({
      access: testHttpAccess, route: get("/records/:id"),
      input: z.object({ id: z.string(), constructor: z.string() }),
      handler: ({ input }) => `${input.id}:${input.constructor}`,
    }));
    manager.register(defineHttpController({
      access: testHttpAccess, route: get("/unnamed/:id"),
      input: z.object({ id: z.string() }), bindings: { id: path() },
      handler: ({ input }) => input.id,
    }));
    manager.register(defineHttpController({
      access: testHttpAccess, route: get("/inferred/:id"),
      // JavaScript callers can supply an undefined override, which keeps inference.
      input: z.object({ id: z.string() }), bindings: { id: undefined as never },
      handler: ({ input }) => input.id,
    }));

    const response = await server.inject("/records/42?constructor=provided");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("42:provided");
    expect((await server.inject("/unnamed/42")).body).toBe("42");
    expect((await server.inject("/inferred/42")).body).toBe("42");
  });

  it("leaves an already-sent response intact when a controller later throws", async () => {
    const { manager, server } = createTestHttp();
    manager.register(defineHttpController({
      access: testHttpAccess, route: post("/accepted"),
      handler: ({ reply }) => {
        reply.code(202).send({ accepted: true });
        throw new Error("work after reply failed");
      },
    }));

    const response = await server.inject({ method: "POST", url: "/accepted" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  });

  it("does not attempt a second send after a handler takes ownership of the reply", async () => {
    const { manager, server } = createTestHttp();
    const onSend = vi.fn();
    const onParse = vi.fn((value: string) => value);
    manager.register(defineHttpController({
      route: post("/owned"),
      output: z.string().transform(onParse),
      handler: ({ reply }) => {
        const send = reply.send.bind(reply);
        reply.send = (payload) => { onSend(payload); return send(payload); };
        reply.code(202).send("owned");
        // Manual replies bypass output parsing and the manager's automatic send.
        return "ignored";
      },
    }));

    const response = await server.inject({ method: "POST", url: "/owned" });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("owned");
    expect(onParse).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledExactlyOnceWith("owned");
  });

  it("supplies anonymous access to direct standalone and action-backed executions", async () => {
    const { app, server } = createTestHttp();
    const observeDefault = vi.fn();
    const standalone = defineHttpController({
      route: get("/standalone"),
      handler: ({ defaultAccess }) => { observeDefault(defaultAccess); return "standalone"; },
    });
    const action = defineAction({
      name: "direct.echo", input: z.object({}), output: z.string(), handler: () => "action",
    });
    const adapted = defineActionHttpController(action, get("/adapted"), {
      audiences: ["public"],
      examples: [{ input: {} }],
      handler: ({ action: runner, defaultAccess }) => { observeDefault(defaultAccess); return runner.run({}); },
    });

    // Extensions can delegate without supplying an inherited access policy.
    for (const controller of [standalone, adapted]) {
      server.get(controller.route.url, async (request, reply) => {
        const execution = await app.createExecutionScope();
        try {
          return await executeHttpController(controller, {}, { request, reply, execution });
        } finally {
          await execution.dispose();
        }
      });
    }
    expect(adapted.audiences).toEqual(["public"]);
    expect(adapted.examples).toEqual([{ input: {} }]);
    expect((await server.inject("/standalone")).body).toBe("standalone");
    expect((await server.inject("/adapted")).body).toBe("action");
    expect(observeDefault.mock.calls).toEqual([[anonymousHttpAccess], [anonymousHttpAccess]]);
  });

  it("rejects unsafe route definitions, blank wire names and non-success controller status codes", () => {
    expect(() => get("records")).toThrow("must start with a slash");
    expect(() => get("//other.example/records")).toThrow("must be a path on the current origin");
    expect(() => body(" ")).toThrow("binding name cannot be empty");
    for (const successStatusCode of [199, 300, 200.5]) {
      expect(() => defineHttpController({
        route: get("/invalid"), successStatusCode, handler: () => undefined,
      })).toThrow("success status code must be a 2xx integer");
    }
  });

  it("retains the body binding kind and the highest valid success status", () => {
    // Generated clients consume the public binding descriptor, including its discriminator.
    expect(body("wireName")).toEqual({ kind: "body", name: "wireName" });
    const controller = defineHttpController({
      route: post("/custom-success"),
      successStatusCode: 299,
      handler: () => undefined,
    });
    expect(controller.successStatusCode).toBe(299);
  });

  it("passes explicit Fastify options to a standalone route", async () => {
    const { manager, server } = createTestHttp();
    manager.register(defineHttpController({
      route: post("/small"),
      fastify: { bodyLimit: 20 },
      handler: () => "accepted",
    }));

    // A route's tighter limit must reject the body before executing the handler.
    expect((await server.inject({ method: "POST", url: "/small", payload: { value: "ok" } })).statusCode).toBe(201);
    expect((await server.inject({ method: "POST", url: "/small", payload: { value: "a".repeat(30) } })).statusCode).toBe(413);
  });

  it("uses the controller description before falling back to the action description", () => {
    const action = defineAction({
      name: "metadata.default", description: "Action description",
      input: z.object({}), output: z.string(), handler: () => "ok",
    });
    const undescribed = defineAction({
      name: "metadata.bare",
      input: z.object({}), output: z.string(), handler: () => "ok",
    });
    expect(defineActionHttpController(action, get("/default-description")).description).toBe("Action description");
    expect(defineActionHttpController(action, get("/override-description"), { description: "HTTP description" }).description)
      .toBe("HTTP description");
    expect(defineActionHttpController(undescribed, get("/only-description"), { description: "HTTP only" }).description)
      .toBe("HTTP only");
  });

  it("inherits action parsing policies and resets replaced controller boundaries", async () => {
    const http = createTestHttp();
    const action = defineAction({
      name: "async.echo",
      input: z.object({ value: z.string().refine(async (value) => value.length > 0) }),
      output: z.string().transform(async (value) => value.toUpperCase()),
      validation: { input: "async", output: "async" },
      handler: ({ value }) => value,
    });
    const inherited = defineActionHttpController(action, post("/inherited"), { access: testHttpAccess });
    http.manager.register(inherited);
    expect(inherited.validation).toEqual({ input: "async", output: "async" });
    const response = await http.server.inject({ method: "POST", url: "/inherited", payload: { value: "value" } });
    expect(response.statusCode).toBe(201);
    expect(response.body).toBe("VALUE");
    const invalid = await http.server.inject({ method: "POST", url: "/inherited", payload: { value: "" } });
    expect(invalid.statusCode).toBe(400);

    const replaced = defineActionHttpController(action, post("/replaced"), {
      access: testHttpAccess,
      input: z.object({ value: z.string() }),
      output: z.string(),
    });
    expect(replaced.validation).toEqual({ input: "sync", output: "sync" });
  });

  it.each([false, true])("requires explicit async parsing on standalone controllers (%s)", async (enabled) => {
    const http = createTestHttp();
    http.manager.register(defineHttpController({
      access: testHttpAccess,
      route: post("/async"),
      input: z.object({ value: z.string().transform(async (value) => value.toUpperCase()) }),
      output: z.string().transform(async (value) => `${value}!`),
      ...(enabled ? { validation: { input: "async" as const, output: "async" as const } } : {}),
      handler: ({ input }) => input.value,
    }));
    const response = await http.server.inject({ method: "POST", url: "/async", payload: { value: "value" } });
    expect(response.statusCode).toBe(enabled ? 201 : 500);
    if (enabled) expect(response.body).toBe("VALUE!");
  });

  it("records the lifecycle of an HTTP execution", async () => {
    const requestedExecutionId = "00000000-0000-4000-8000-000000000042";
    const http = createTestHttp({
      executionIdHeader: "x-test-execution-id",
    });
    const events: ObservationEvent[] = [];
    const observerContext = new AsyncLocalObserverContext();

    const recorder: ObservationRecorder = {
      enqueue: (event: ObservationEvent) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };

    http.app.container.registerValue("observationRecorder", recorder);
    http.app.container.registerValue("observerContext", observerContext);
    http.app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );
    http.manager.register(defineHttpController({
      access: testHttpAccess,
      route: get("/observed"),
      handler: ({ execution }) => {
        expect(observerContext.get()).toBeDefined();
        expect(execution.context.get("operation")).toBe("GET /observed");
        expect(execution.context.get("transport")).toBe("http");
        expect(execution.context.get("workload")).toBe("http");

        return { status: "ok" };
      },
    }));

    const beforeRequest = performance.now();
    const response = await http.server.inject({
      method: "GET",
      url: "/observed",
      headers: {
        "x-test-execution-id": requestedExecutionId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-test-execution-id"]).toBe(
      requestedExecutionId,
    );
    expect(events[0]?.executionId).toBe(requestedExecutionId);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "execution.completed",
    ]);
    expect(events[0]?.data).toEqual({
      operation: "GET /observed",
      transport: "http",
    });
    expect(events[1]).toMatchObject({
      executionId: events[0]?.executionId,
      outcome: "success",
      data: {
        operation: "GET /observed",
        transport: "http",
        statusCode: 200,
      },
    });
    expect(events[1]?.data).not.toHaveProperty("error");
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[1]?.durationMs).toBeLessThanOrEqual(performance.now() - beforeRequest);
  });

  it.each([
    { stage: "logging", status: 500, outcome: "failure" },
    { stage: "setup", status: 500, outcome: "failure" },
    { stage: "start", status: 500, outcome: "failure" },
    { stage: "completion", status: 200, outcome: "success" },
  ])("disposes a request scope when $stage fails", async ({ stage, status, outcome }) => {
    const executionId = "00000000-0000-4000-8000-000000000042";
    const { app, manager, server } = createTestHttp({ executionIdHeader: "x-execution-id", executionLog: false });
    const onComplete = vi.fn();
    const handler = vi.fn(() => "ok");
    const failure = new Error("private observation failure");
    const handleHttp = vi.spyOn(app.container.resolve(errorHandlerDependency), "handleHttp");
    if (stage === "logging") {
      app.container.registerValue(setExecutionLogEnabledDependency.id, () => { throw failure; });
    }
    const observer = {
      record(definition: unknown) {
        if ((stage === "start" && definition === executionStartedObservation)
          || (stage === "completion" && definition === executionCompletedObservation)) throw failure;
      },
    };
    app.eventBus.listen(executionCompletedEvent, onComplete, { scope: "descendants" });
    app.container.registerFactory("observer", () => {
      if (stage === "setup") throw failure;
      return observer;
    }, { lifetime: "scoped" });
    manager.register(defineHttpController({ route: get("/observer-failure"), handler }));

    // Capture the scope so a mutant that skips disposal cannot hang application teardown.
    let scope: Awaited<ReturnType<typeof createExecutionScope>> | undefined;
    const capture = vi.mocked(app.createExecutionScope);
    const createExecutionScope = capture.getMockImplementation()!;
    capture.mockImplementationOnce(async (id) => {
      scope = await createExecutionScope(id);
      return scope;
    });
    try {
      const response = await server.inject({ url: "/observer-failure", headers: { "x-execution-id": executionId } });
      expect(response.statusCode).toBe(status);
      expect(response.headers["x-execution-id"]).toBe(executionId);
      expect(response.body).not.toContain(failure.message);
      if (stage === "completion") {
        expect(handler).toHaveBeenCalledOnce();
        expect(response.body).toBe("ok");
        expect(handleHttp).not.toHaveBeenCalled();
      } else {
        expect(handler).not.toHaveBeenCalled();
        expect(response.json()).toMatchObject({ message: "An unexpected error occurred.", executionId });
      }
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome }), expect.anything());
    } finally {
      capture.mockRestore();
      await scope?.dispose().catch(() => undefined);
    }
  });

  it("records the failure reason when a handler rejects with undefined", async () => {
    const { app, manager, server } = createTestHttp();
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    manager.register(defineHttpController({
      route: get("/undefined-failure"),
      handler: () => Promise.reject(undefined),
    }));

    // A missing error value is still a rejected execution.
    expect((await server.inject("/undefined-failure")).statusCode).toBe(500);
    expect(record).toHaveBeenCalledWith(executionCompletedObservation, expect.objectContaining({
      error: { name: "UnknownError", message: "undefined" },
    }), expect.objectContaining({ outcome: "failure" }));
  });

  it("generates a UUID when the requested execution id is invalid", async () => {
    const http = createTestHttp({
      executionIdHeader: "x-test-execution-id",
    });

    http.manager.register(defineHttpController({
      access: testHttpAccess,
      route: get("/generated-execution"),
      handler: () => ({ status: "ok" }),
    }));

    const firstResponse = await http.server.inject({
      method: "GET",
      url: "/generated-execution",
      headers: { "x-test-execution-id": "req-1" },
    });
    const secondResponse = await http.server.inject({
      method: "GET",
      url: "/generated-execution",
      headers: { "x-test-execution-id": "req-1" },
    });
    const firstExecutionId = firstResponse.headers["x-test-execution-id"];
    const secondExecutionId = secondResponse.headers["x-test-execution-id"];

    expect(z.uuid().safeParse(firstExecutionId).success).toBe(true);
    expect(z.uuid().safeParse(secondExecutionId).success).toBe(true);
    expect(secondExecutionId).not.toBe(firstExecutionId);
  });

  it("applies the configured execution-log policy to each managed request", async () => {
    const http = createTestHttp({ executionLog: false });
    const setExecutionLogEnabled = vi.fn();

    http.app.container.registerFactory(
      setExecutionLogEnabledDependency.id,
      () => setExecutionLogEnabled,
      { lifetime: "scoped" },
    );
    http.manager.register(defineHttpController({
      access: testHttpAccess,
      route: get("/technical"),
      handler: () => ({ status: "ok" }),
    }));

    const response = await http.server.inject({
      method: "GET",
      url: "/technical",
    });

    expect(response.statusCode).toBe(200);
    expect(setExecutionLogEnabled).toHaveBeenCalledOnce();
    expect(setExecutionLogEnabled).toHaveBeenCalledWith(false);
  });

  it("serves requests with a configured log policy when execution logging is not registered", async () => {
    const { manager, server } = createTestHttp({ executionLog: false });
    manager.register(defineHttpController({ route: get("/bare"), handler: () => "ok" }));

    expect((await server.inject("/bare")).body).toBe("ok");
  });

  it("preserves the scoped logging default when the manager has no configured policy", async () => {
    const { app, manager, server } = createTestHttp();
    const setExecutionLogEnabled = vi.fn();
    app.container.registerValue(setExecutionLogEnabledDependency.id, setExecutionLogEnabled);
    manager.register(defineHttpController({ route: get("/default-log"), handler: () => "ok" }));

    expect((await server.inject("/default-log")).body).toBe("ok");
    expect(setExecutionLogEnabled).not.toHaveBeenCalled();
  });

  it("runs a standalone controller with optional input and output", async () => {
    const http = createTestHttp();
    const controller = defineHttpController({
      access: testHttpAccess,
      route: get("/health"),
      description: "Report application health.",
      handler: () => ({ status: "ok" }),
    });

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "GET",
      url: "/health",
    });

    expect(controller.source).toBe("standalone");
    expect(controller.description).toBe("Report application health.");
    expect(controller.outputSchema).toBeUndefined();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("inherits an action output contract without applying its transform twice", async () => {
    const action = defineAction({
      name: "greeting.read",
      input: z.object({}),
      output: z.string().transform((value) => `${value}!`),
      handler: () => "Hello",
    });
    const controller = defineActionHttpController(
      action,
      get("/greeting"),
      { access: testHttpAccess },
    );
    const http = createTestHttp();

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "GET",
      url: "/greeting",
    });

    expect(controller.outputSchema).toBe(action.outputSchema);
    expect(response.body).toBe("Hello!");
  });

  it("uses an explicit controller output for a custom response mapping", async () => {
    const action = defineAction({
      name: "profile.read",
      input: z.object({}),
      output: z.object({ name: z.string() }),
      handler: () => ({ name: "Ada" }),
    });
    const output = z.string().transform((value) => value.toUpperCase());
    const controller = defineActionHttpController(
      action,
      get("/profile"),
      {
        access: testHttpAccess,
        output,
        handler: async ({ action: runner, input }) =>
          (await runner.run(input)).name,
      },
    );
    const http = createTestHttp();

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "GET",
      url: "/profile",
    });

    expect(controller.outputSchema).toBe(output);
    expect(response.body).toBe("ADA");
  });

  it("applies controller output validation to a custom handler and to a replaced output schema", async () => {
    const { manager, server } = createTestHttp();
    const action = defineAction({
      name: "output.validation", input: z.object({}),
      output: z.string().transform((value) => value.toUpperCase()),
      handler: () => "action",
    });
    manager.register(defineActionHttpController(action, get("/custom"), { handler: () => "custom" }));
    manager.register(defineActionHttpController(action, get("/replacement"), {
      output: z.string().transform((value) => `${value}!`),
    }));

    expect((await server.inject("/custom")).body).toBe("CUSTOM");
    expect((await server.inject("/replacement")).body).toBe("ACTION!");
  });

  it("retains reusable request examples on the controller contract", () => {
    const controller = defineHttpController({
      access: testHttpAccess,
      route: get("/users/:id"),
      input: z.object({ id: z.uuid() }),
      examples: [{
        name: "Known user",
        input: { id: "00000000-0000-4000-8000-000000000001" },
      }],
      handler: ({ input }) => input,
    });

    expect(controller.examples).toEqual([{
      name: "Known user",
      input: { id: "00000000-0000-4000-8000-000000000001" },
    }]);
  });

  it("resolves standalone dependencies and parses declared output", async () => {
    const http = createTestHttp();

    http.app.container.registerValue("prefix", "Hello");
    http.manager.register(
      defineHttpController({
        access: testHttpAccess,
        route: get("/standalone/:name"),
        input: z.object({ name: z.string() }),
        output: z.object({ message: z.string() })
          .transform(({ message }) => message.toUpperCase()),
        dependencies: {
          prefix: dep<string>("prefix"),
        },
        handler: ({ deps, input }) => ({
          message: `${deps.prefix} ${input.name}`,
        }),
      }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/standalone/Ada",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("HELLO ADA");
  });

  it.each([false, true])("runs access around local middleware and output validation (inherited: %s)", async (inherited) => {
    const events: string[] = [];
    const dependencies = {
      label: dep<string>("label"),
    } as const;
    const middleware = defineHttpMiddleware<
      { name: string },
      typeof dependencies
    >(
      "test.http",
      {
        dependencies,
        handler: async ({ deps, input }, next) => {
          events.push(`before:${deps.label}:${input.name}`);
          const result = await next();

          events.push("after");

          return result;
        },
      },
    );
    const access = defineHttpAccessPolicy("test.http.restricted", [
      defineHttpMiddleware("test.http.access", {
        handler: async (_context, next) => {
          events.push("access:before");
          const result = await next();

          events.push("access:after");
          return result;
        },
      }),
    ]);
    const http = createTestHttp(inherited ? { defaultAccess: access } : {});

    http.app.container.registerValue("label", "http");
    http.manager.register(
      defineHttpController({
        ...(inherited ? {} : { access }),
        route: get("/middleware/:name"),
        input: z.object({ name: z.string() }),
        output: z.string().transform((value) => value.toUpperCase()),
        middleware: [middleware],
        handler: ({ input }) => {
          events.push("handler");

          return input.name;
        },
      }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/middleware/Ada",
    });

    expect(response.body).toBe("ADA");
    expect(events).toEqual([
      "access:before",
      "before:http:Ada",
      "handler",
      "after",
      "access:after",
    ]);
  });

  it("maps POST route parameters and remaining fields to the body", async () => {
    const action = defineAction({
      name: "message.create",
      input: z.object({
        id: z.coerce.number().int(),
        message: z.string(),
      }),
      output: z.object({
        id: z.number().int(),
        message: z.string(),
      }),
      description: "Create a message.",
      handler: (input) => input,
    });
    const controller = defineActionHttpController(
      action,
      post("/messages/:id"),
      { access: testHttpAccess },
    );
    const http = createTestHttp();

    expect(controller.description).toBe("Create a message.");

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "POST",
      url: "/messages/7",
      payload: { message: "Hello" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 7,
      message: "Hello",
    });
  });

  it("maps GET route parameters and remaining fields to the query", async () => {
    const action = defineAction({
      name: "message.search",
      input: z.object({
        category: z.string(),
        search: z.string(),
      }),
      output: z.object({
        category: z.string(),
        search: z.string(),
      }),
      handler: (input) => input,
    });
    const controller = defineActionHttpController(
      action,
      get("/messages/:category"),
      { access: testHttpAccess },
    );
    const http = createTestHttp();

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "GET",
      url: "/messages/news?search=latest",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      category: "news",
      search: "latest",
    });
  });

  it("supports explicit path and query bindings", async () => {
    const action = defineAction({
      name: "search.read",
      input: z.object({
        resourceId: z.string(),
        search: z.string(),
      }),
      output: z.string(),
      handler: ({ resourceId, search }) =>
        `${resourceId}:${search}`,
    });
    const controller = defineActionHttpController(
      action,
      get("/resources/:id"),
      {
        access: testHttpAccess,
        bindings: {
          resourceId: path("id"),
          search: query("q"),
        },
      },
    );
    const http = createTestHttp();

    http.manager.register(controller);

    const response = await http.server.inject({
      method: "GET",
      url: "/resources/example?q=term",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("example:term");
  });

  it("returns a structured bad request for invalid controller input", async () => {
    const action = defineAction({
      name: "email.create",
      input: z.object({ email: z.email() }),
      output: z.string(),
      handler: ({ email }) => email,
    });
    const http = createTestHttp();

    http.manager.register(
      defineActionHttpController(action, post("/emails"), { access: testHttpAccess }),
    );

    const response = await http.server.inject({
      method: "POST",
      url: "/emails",
      payload: { email: "invalid" },
    });
    const body = response.json<{
      statusCode: number;
      error: string;
      message: string;
      issues: unknown[];
    }>();

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: "The request input is invalid.",
    });
    expect(body.issues).not.toHaveLength(0);
  });

  it("maps a null action result to not found", async () => {
    const action = defineAction({
      name: "resource.get",
      input: z.object({ id: z.string() }),
      output: z.string().nullable(),
      handler: () => null,
    });
    const http = createTestHttp();

    http.manager.register(
      defineActionHttpController(action, get("/resources/:id"), { access: testHttpAccess }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/resources/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "The requested resource was not found.",
    });
  });

  it("resolves controller dependencies for custom handlers", async () => {
    const action = defineAction({
      name: "name.read",
      input: z.object({ name: z.string() }),
      output: z.string(),
      handler: ({ name }) => name,
    });
    const http = createTestHttp();

    http.app.container.registerValue("prefix", "Hello");
    http.manager.register(
      defineActionHttpController(action, get("/greetings/:name"), {
        access: testHttpAccess,
        dependencies: {
          prefix: dep<string>("prefix"),
        },
        handler: async ({ action: runner, deps, input }) => {
          const name = await runner.run(input);

          return `${deps.prefix} ${name}`;
        },
      }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/greetings/Ada",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("Hello Ada");
  });

  it("shares scoped dependencies between actions in one request", async () => {
    const dispose = vi.fn();
    const createScopedAction = (name: string) =>
      defineAction({
        name,
        input: z.object({}),
        output: z.custom<object>((value) => typeof value === "object"),
        dependencies: {
          resource: dep<object>("resource"),
        },
        handler: (_input, { resource }) => resource,
      });
    const firstAction = createScopedAction("scope.first");
    const secondAction = createScopedAction("scope.second");
    const http = createTestHttp();

    http.app.container.registerFactory(
      "resource",
      () => ({}),
      {
        lifetime: "scoped",
        dispose,
      },
    );
    http.manager.register(
      defineActionHttpController(firstAction, get("/scope"), {
        access: testHttpAccess,
        // The custom handler replaces the action object with a wire string.
        output: z.string(),
        handler: async ({ action, execution, input }) => {
          const first = await action.run(input);
          const second = await execution
            .get(secondAction)
            .run(input);

          return first === second ? "shared" : "different";
        },
      }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/scope",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("shared");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("hides unexpected action errors with the safe default handler", async () => {
    const cause = new Error("relation does not exist");
    const failure = new Error("Action failed", { cause });
    const action = defineAction({
      name: "failure.run",
      input: z.object({}),
      output: z.never(),
      handler: () => {
        throw failure;
      },
    });
    const http = createTestHttp();
    const events: ObservationEvent[] = [];
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };

    http.app.container.registerValue("observationRecorder", recorder);
    http.app.container.registerValue(
      "observerContext",
      new AsyncLocalObserverContext(),
    );
    http.app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );

    http.manager.register(
      defineActionHttpController(action, get("/failure"), { access: testHttpAccess }),
    );

    const response = await http.server.inject({
      method: "GET",
      url: "/failure",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
      executionId: expect.any(String),
    });
    expect(events.at(-1)).toMatchObject({
      name: "execution.completed",
      schemaVersion: 2,
      outcome: "failure",
      data: {
        operation: "GET /failure",
        transport: "http",
        statusCode: 500,
        error: {
          name: "Error",
          message: "Action failed",
          stack: expect.any(String),
          causes: [{
            name: "Error",
            message: "relation does not exist",
            stack: expect.any(String),
          }],
        },
      },
    });
  });

  it("sends the representation exposed by an expected HTTP error", async () => {
    class ConflictError extends Error implements HttpRepresentableError {
      public toHttpError() {
        return {
          statusCode: 409,
          message: "The resource already exists.",
          headers: { "retry-after": "10" },
          extensions: { code: "resource_exists" },
        };
      }
    }

    const action = defineAction({
      name: "conflict.run",
      input: z.object({}),
      output: z.never(),
      handler: () => {
        throw new ConflictError("Internal details");
      },
    });
    const http = createTestHttp();

    http.manager.register(
      defineActionHttpController(action, post("/conflict"), { access: testHttpAccess }),
    );

    const response = await http.server.inject({
      method: "POST",
      url: "/conflict",
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["retry-after"]).toBe("10");
    expect(response.json()).toEqual({
      statusCode: 409,
      error: "Conflict",
      message: "The resource already exists.",
      code: "resource_exists",
    });
  });

  it("rejects path bindings missing from the route", () => {
    const action = defineAction({
      name: "resource.get",
      input: z.object({ resourceId: z.string() }),
      output: z.string(),
      handler: ({ resourceId }) => resourceId,
    });
    const controller = defineActionHttpController(
      action,
      get("/resources/:id"),
      {
        access: testHttpAccess,
        bindings: {
          resourceId: path("missing"),
        },
      },
    );
    const http = createTestHttp();

    expect(() => http.manager.register(controller)).toThrow(
      'HTTP path binding "missing" does not exist in route "/resources/:id".',
    );
  });
});

function emptyRecorderHealth() {
  return {
    status: "healthy" as const,
    pendingCount: 0,
    droppedCount: 0,
    droppedByOverflow: 0,
    droppedByStorageFailure: 0,
    consecutiveStorageFailures: 0,
  };
}
