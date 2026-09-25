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
import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import type { HttpRepresentableError } from "../errors/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import {
  AsyncLocalObserverContext,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import {
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
  const server = Fastify();
  const app = new App({});

  apps.add(app);
  servers.add(server);
  server.addHook("onReady", async () => app.start());

  return {
    app,
    manager: new HttpControllerManager(app, server, options),
    server,
  };
}

describe("HttpControllerManager", () => {
  it("inherits action parsing policies and resets replaced controller boundaries", async () => {
    const http = createTestHttp();
    const action = defineAction({
      name: "async.echo",
      input: z.object({ value: z.string().refine(async (value) => value.length > 0) }),
      output: z.string().transform(async (value) => value.toUpperCase()),
      validation: { input: "async", output: "async" },
      handler: ({ value }) => value,
    });
    const inherited = defineActionHttpController(action, post("/inherited"), testHttpAccess);
    http.manager.register(inherited);
    expect(inherited.validation).toEqual({ input: "async", output: "async" });
    const response = await http.server.inject({ method: "POST", url: "/inherited", payload: { value: "value" } });
    expect(response.statusCode).toBe(201);
    expect(response.body).toBe("VALUE");
    const invalid = await http.server.inject({ method: "POST", url: "/inherited", payload: { value: "" } });
    expect(invalid.statusCode).toBe(400);

    const replaced = defineActionHttpController(action, post("/replaced"), testHttpAccess, {
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
      handler: () => {
        expect(observerContext.get()).toBeDefined();

        return { status: "ok" };
      },
    }));

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
      testHttpAccess,
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
      testHttpAccess,
      {
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

  it("runs HTTP middleware around the handler and output validation", async () => {
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
    const http = createTestHttp();

    http.app.container.registerValue("label", "http");
    http.manager.register(
      defineHttpController({
        access,
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
      testHttpAccess,
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
      testHttpAccess,
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
      testHttpAccess,
      {
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
      defineActionHttpController(action, post("/emails"), testHttpAccess),
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
      defineActionHttpController(action, get("/resources/:id"), testHttpAccess),
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
      defineActionHttpController(action, get("/greetings/:name"), testHttpAccess, {
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
      defineActionHttpController(firstAction, get("/scope"), testHttpAccess, {
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
      defineActionHttpController(action, get("/failure"), testHttpAccess),
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
      defineActionHttpController(action, post("/conflict"), testHttpAccess),
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
      testHttpAccess,
      {
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
