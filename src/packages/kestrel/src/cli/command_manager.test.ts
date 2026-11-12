import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  App,
  executionCompletedEvent,
} from "../app/index.js";
import { dep } from "../di/index.js";
import {
  type CliRepresentableError,
  DefaultErrorHandler,
} from "../errors/index.js";
import {
  AsyncLocalObserverContext,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import {
  CliCommandManager,
  defineActionCliController,
  defineCliController,
  defineCliMiddleware,
  option,
  param,
  repeatableOption,
} from "./index.js";

interface TestCli {
  app: App<Record<string, never>>;
  manager: CliCommandManager<Record<string, never>>;
  output: string[];
  errors: string[];
}

function createTestCli(version?: string): TestCli {
  const output: string[] = [];
  const errors: string[] = [];
  const app = new App({});
  const manager = new CliCommandManager(app, {
    name: "test",
    ...(version === undefined ? {} : { version }),
    writeOutput: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  });

  return { app, manager, output, errors };
}

describe("CliCommandManager", () => {
  it("awaits async dependencies shared by CLI middleware and controller", async () => {
    const cli = createTestCli();
    const resource = { label: "ready" };
    const create = vi.fn(async () => resource);
    const dispose = vi.fn();
    const dependency = dep<typeof resource>("asyncResource");
    cli.app.container.registerAsyncFactory("asyncResource", {}, create, { lifetime: "scoped", dispose });
    cli.manager.register(defineCliController({
      command: "async-resource",
      dependencies: { resource: dependency },
      middleware: [defineCliMiddleware("test.async", {
        dependencies: { resource: dependency },
        handler: async ({ deps }, next) => { expect(deps.resource).toBe(resource); return next(); },
      })],
      handler: ({ deps }) => deps.resource.label,
    }));
    try {
      expect(await cli.manager.run(["async-resource"])).toBe(0);
      expect(cli.errors).toEqual([]);
      expect(cli.output.join("")).toContain("ready");
      expect(create).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    } finally {
      await cli.app.dispose();
    }
  });

  it("retains inherited async action input and independently validates CLI output", async () => {
    const cli = createTestCli();
    const action = defineAction({
      name: "async.echo",
      input: z.object({ value: z.string().refine(async (value) => value.length > 0) }),
      output: z.string(),
      validation: { input: "async" },
      handler: ({ value }) => value,
    });
    const inherited = defineActionCliController(action, "inherited");
    expect(inherited.validation.input).toBe("async");
    cli.manager.register(inherited);
    cli.manager.register(defineActionCliController(action, "mapped", {
      output: z.string().transform(async (value) => value.toUpperCase()),
      validation: { input: "async", output: "async" },
    }));
    try {
      expect(await cli.manager.run(["inherited", "--value", "value"])).toBe(0);
      expect(await cli.manager.run(["mapped", "--value", "value"])).toBe(0);
      expect(cli.output.join("")).toContain("VALUE");
      expect(cli.errors).toEqual([]);
    } finally {
      await cli.app.dispose();
    }
  });

  it("selects the controller running mode before providers boot", async () => {
    const cli = createTestCli();
    const bootMode = vi.fn<(mode: string) => void>();

    cli.app.register({
      register() {},
      boot(app) {
        bootMode(app.bootPlan.runningMode);
      },
    });
    cli.manager.register(defineCliController({
      command: "database reset",
      runningMode: "minimal",
      handler: () => ({ status: "ok" }),
    }));

    const exitCode = await cli.manager.run(["database", "reset"]);

    expect(exitCode).toBe(0);
    expect(cli.app.bootPlan.runningMode).toBe("minimal");
    expect(bootMode).toHaveBeenCalledWith("minimal");
  });

  it("uses standard mode when a controller does not override it", async () => {
    const cli = createTestCli();

    cli.manager.register(defineCliController({
      command: "health read",
      handler: () => ({ status: "ok" }),
    }));

    await cli.manager.run(["health", "read"]);

    expect(cli.app.bootPlan.runningMode).toBe("standard");
  });

  it("selects controller workloads before providers boot", async () => {
    const cli = createTestCli();
    const bootWorkloads = vi.fn<(workloads: readonly string[]) => void>();

    cli.app.register({
      register() {},
      boot(app) {
        bootWorkloads(app.bootPlan.workloads);
      },
    });
    cli.manager.register(defineCliController({
      command: "run workers",
      runtime: "worker",
      workloads: ["workers"],
      handler: () => undefined,
    }));

    await cli.manager.run(["run", "workers"]);

    expect(cli.app.bootPlan.workloads).toEqual(["workers"]);
    expect(cli.app.bootPlan.runtime).toBe("worker");
    expect(bootWorkloads).toHaveBeenCalledWith(["workers"]);
  });

  it("does not bootstrap infrastructure for help output", async () => {
    const cli = createTestCli();
    const boot = vi.fn();

    cli.app.register({ register() {}, boot });
    cli.manager.register(defineCliController({
      command: "run workers",
      workloads: ["workers"],
      handler: () => undefined,
    }));

    const exitCode = await cli.manager.run(["run", "--help"]);

    expect(exitCode).toBe(0);
    expect(cli.app.state).toBe("composing");
    expect(boot).not.toHaveBeenCalled();
  });

  it.each([
    { arguments: [], text: "Usage: test" },
    { arguments: ["-V"], text: "1.2.3" },
    { arguments: ["--version"], text: "1.2.3" },
    { arguments: ["help", "echo"], text: "Usage: test echo" },
    { arguments: ["echo", "-h"], text: "Usage: test echo" },
  ])("renders $arguments without selecting workloads or booting providers", async (invocation) => {
    const cli = createTestCli("1.2.3");
    const boot = vi.fn();
    const prepareWorkloads = vi.fn(() => {
      throw new Error("Workload preparation requires execution arguments.");
    });
    cli.app.register({ register() {}, boot });
    cli.manager.register(defineCliController({
      command: "echo",
      prepareWorkloads,
      handler: () => "echo",
    }));

    try {
      expect(await cli.manager.run(invocation.arguments)).toBe(0);
      expect(cli.output.join("")).toContain(invocation.text);
      expect(cli.errors).toEqual([]);
      expect(cli.app.state).toBe("composing");
      expect(prepareWorkloads).not.toHaveBeenCalled();
      expect(boot).not.toHaveBeenCalled();
    } finally {
      await cli.app.dispose();
    }
  });

  it.each([
    { input: ["--", "--help"], value: "--help", binding: param(0) },
    { input: ["--message", "--help"], value: "--help", binding: option() },
    { input: ["--message", "-V"], value: "-V", binding: option("message") },
  ])("executes a command with literal input $input", async (invocation) => {
    const cli = createTestCli();
    const boot = vi.fn();
    cli.app.register({ register() {}, boot });
    cli.manager.register(defineCliController({
      command: "echo",
      input: z.object({ message: z.string() }),
      bindings: { message: invocation.binding },
      handler: ({ input }) => input.message,
    }));

    try {
      expect(await cli.manager.run(["echo", ...invocation.input])).toBe(0);
      expect(cli.output).toEqual([`${JSON.stringify(invocation.value)}\n`]);
      expect(cli.errors).toEqual([]);
      expect(boot).toHaveBeenCalledOnce();
    } finally {
      await cli.app.dispose();
    }
  });

  it("prepares the selected nested action with its original invocation arguments", async () => {
    const cli = createTestCli();
    const arguments_ = ["--_format", "json", "work", "start"];
    const prepareWorkloads = vi.fn(() => ["workers"] as const);
    const start = defineAction({
      name: "work.start",
      input: z.object({}),
      output: z.object({ status: z.string() }),
      handler: () => ({ status: "started" }),
    });
    cli.manager.register(defineCliController({ command: "work", handler: () => "parent" }));
    cli.manager.register(defineActionCliController(start, "work start", {
      input: z.object({ note: z.string().optional() }),
      bindings: { note: param(0) },
      runtime: "worker",
      workloads: ["scheduled-tasks"],
      prepareWorkloads,
      handler: ({ action, input, writeProgress }) => {
        writeProgress?.(input.note ?? "Starting work");
        return action.run({});
      },
    }));

    try {
      expect(await cli.manager.run(arguments_)).toBe(0);
      expect(prepareWorkloads).toHaveBeenCalledExactlyOnceWith(arguments_);
      expect(cli.app.bootPlan).toMatchObject({ runtime: "worker", workloads: ["workers"] });
      expect(cli.output).toEqual(['{"status":"started"}\n']);
      expect(cli.errors).toEqual(["Starting work\n"]);
    } finally {
      await cli.app.dispose();
    }
  });

  it("can prepare the deepest matching controller before execution", async () => {
    const cli = createTestCli();
    cli.manager.register(defineCliController({ command: "work", handler: () => undefined }));
    cli.manager.register(defineCliController({
      command: "work start",
      workloads: ["workers"],
      runningMode: "minimal",
      handler: () => undefined,
    }));

    try {
      cli.manager.prepare(["work", "--_format=pretty", "start"]);
      expect(cli.app.bootPlan).toMatchObject({ runningMode: "minimal", workloads: ["workers"] });

      cli.manager.prepare(["--_format", "json", "work"]);
      expect(cli.app.bootPlan).toMatchObject({ runningMode: "standard", workloads: [] });
      expect(cli.app.state).toBe("composing");
    } finally {
      await cli.app.dispose();
    }
  });

  it("reports usage for a missing subcommand without booting providers", async () => {
    const cli = createTestCli();
    const boot = vi.fn();
    cli.app.register({ register() {}, boot });
    cli.manager.register(defineCliController({ command: "work start", handler: () => undefined }));

    try {
      expect(await cli.manager.run(["work"])).toBe(2);
      expect(cli.errors.join("")).toContain("Usage: test work");
      expect(boot).not.toHaveBeenCalled();
    } finally {
      await cli.app.dispose();
    }
  });

  it("returns a safe startup failure without invoking the handler", async () => {
    const cli = createTestCli();
    const handler = vi.fn();
    cli.app.register({
      register() {},
      boot() { throw new Error("Private infrastructure failure"); },
    });
    cli.manager.register(defineCliController({ command: "run", handler }));

    try {
      expect(await cli.manager.run(["run"])).toBe(1);
      expect(cli.output).toEqual([]);
      expect(cli.errors).toEqual(["An unexpected CLI error occurred.\n"]);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await cli.app.dispose();
    }
  });

  it.each([
    { bindings: { first: param(0), second: param(0) } },
    { bindings: { first: param(0), second: param(2) } },
  ])("rejects non-contiguous or conflicting positional bindings $bindings", async ({ bindings }) => {
    const cli = createTestCli();
    try {
      expect(() => cli.manager.register(defineCliController({
        command: "echo",
        input: z.object({ first: z.string(), second: z.string() }),
        bindings,
        handler: () => undefined,
      }))).toThrow("CLI positional parameter indexes must be unique and contiguous.");
    } finally {
      await cli.app.dispose();
    }
  });

  it("rejects a schema field reserved for global output formatting", async () => {
    const cli = createTestCli();
    try {
      expect(() => cli.manager.register(defineCliController({
        command: "echo",
        input: z.object({ _format: z.string() }),
        handler: () => undefined,
      }))).toThrow('The CLI input field "_format" is reserved.');
    } finally {
      await cli.app.dispose();
    }
  });

  it("rejects registering an exact command path twice", async () => {
    const cli = createTestCli();
    try {
      const echo = defineCliController({ command: "text echo", handler: () => undefined });
      cli.manager.register(echo);
      expect(() => cli.manager.register(echo)).toThrow('CLI command "text echo" is already registered.');
    } finally {
      await cli.app.dispose();
    }
  });

  it.each([-1, 1.5])("rejects invalid positional index %s", (index) => {
    expect(() => param(index)).toThrow("A CLI parameter index must be a non-negative integer.");
  });

  it("rejects a blank command path", () => {
    expect(() => defineCliController({ command: " \t", handler: () => undefined }))
      .toThrow("A CLI command path cannot be empty.");
  });

  it("collects repeatable options into array inputs", async () => {
    const cli = createTestCli();
    const handler = vi.fn();

    cli.manager.register(defineCliController({
      command: "run tasks",
      input: z.object({ taskIds: z.array(z.string()).default([]) }),
      bindings: { taskIds: repeatableOption("task") },
      handler,
    }));

    await cli.manager.run([
      "run",
      "tasks",
      "--task=first",
      "--task",
      "second",
    ]);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      input: { taskIds: ["first", "second"] },
    }));
  });

  it("ends the execution after printing its primary result", async () => {
    const cli = createTestCli();
    const ended = vi.fn(() => {
      expect(cli.output).toEqual(['{\n  "status": "ok"\n}\n']);
    });

    cli.app.eventBus.listen(executionCompletedEvent, ended, {
      scope: "descendants",
    });
    cli.manager.register(defineCliController({
      command: "lifecycle run",
      handler: () => ({ status: "ok" }),
    }));

    const exitCode = await cli.manager.run(["lifecycle", "run"]);

    expect(exitCode).toBe(0);
    expect(ended).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)("records the lifecycle of a %s CLI execution", async (outcome) => {
    const cli = createTestCli();
    const events: ObservationEvent[] = [];
    const observerContext = new AsyncLocalObserverContext();
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };

    cli.app.container.registerValue("observationRecorder", recorder);
    cli.app.container.registerValue("observerContext", observerContext);
    cli.app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );
    cli.manager.register(defineCliController({
      command: "observed run",
      input: z.object({
        input: z.string().transform((value) => {
          if (outcome === "failure") throw new Error("Schema transform failed");
          return value;
        }),
      }),
      handler: () => {
        expect(observerContext.get()).toBeDefined();

        return { status: "ok" };
      },
    }));

    try {
      expect(await cli.manager.run(["observed", "run", "--input=value"])).toBe(outcome === "success" ? 0 : 1);
      expect(events.map((event) => event.name)).toEqual([
        "execution.started",
        "execution.completed",
      ]);
      expect(events[0]?.data).toEqual({
        operation: "observed run",
        transport: "cli",
      });
      expect(events[1]).toMatchObject({
        executionId: events[0]?.executionId,
        outcome,
        data: {
          operation: "observed run",
          transport: "cli",
          ...(outcome === "failure" ? { error: { message: "Schema transform failed" } } : {}),
        },
      });
    } finally {
      await cli.app.dispose();
    }
  });

  it.each(["resolve", "execution.started", "execution.completed"] as const)(
    "disposes the execution when the observer fails at %s",
    async (failurePoint) => {
      const app = new App({}, { shutdown: { timeoutMs: 100, drainMs: 20 } });
      const completed = vi.fn();
      const handler = vi.fn(() => "done");
      const manager = new CliCommandManager(app, { writeOutput() {}, writeError() {} });
      const failure = new Error("Observation unavailable");
      const recorder: ObservationRecorder = {
        enqueue(event) {
          if (event.name === failurePoint) throw failure;
        },
        flush: async () => {},
        close: async () => {},
        getHealth: () => emptyRecorderHealth(),
      };
      app.eventBus.listen(executionCompletedEvent, completed, { scope: "descendants" });
      app.container.registerFactory(
        "observer",
        ({ executionId }: { executionId: string }) => {
          if (failurePoint === "resolve") throw failure;
          return new ScopedObserver(executionId, recorder);
        },
        { lifetime: "scoped" },
      );
      manager.register(defineCliController({ command: "run", handler }));

      try {
        expect(await manager.run(["run"])).toBe(1);
        expect(completed).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledTimes(failurePoint === "execution.completed" ? 1 : 0);
        await expect(app.dispose()).resolves.toBeUndefined();
      } finally {
        // The short deadline also releases a scope if this regression reappears.
        await app.dispose().catch(() => undefined);
      }
    },
  );

  it("can disable observations for infrastructure maintenance", async () => {
    const cli = createTestCli();
    const events: ObservationEvent[] = [];
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };

    cli.app.container.registerValue("observationRecorder", recorder);
    cli.app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );
    cli.manager.register(defineCliController({
      command: "maintenance run",
      observe: false,
      handler: () => ({ status: "ok" }),
    }));

    const exitCode = await cli.manager.run(["maintenance", "run"]);

    expect(exitCode).toBe(0);
    expect(events).toEqual([]);
  });

  it("runs a standalone command with optional input and output", async () => {
    const cli = createTestCli();
    const controller = defineCliController({
      command: "health read",
      description: "Report application health.",
      handler: () => ({ status: "ok" }),
    });

    cli.manager.register(controller);

    const exitCode = await cli.manager.run(["health", "read"]);

    expect(exitCode).toBe(0);
    expect(controller.source).toBe("standalone");
    expect(controller.description).toBe("Report application health.");
    expect(controller.outputSchema).toBeUndefined();
    expect(cli.output).toEqual(['{\n  "status": "ok"\n}\n']);
  });

  it("resolves standalone dependencies and parses declared output", async () => {
    const cli = createTestCli();

    cli.app.container.registerValue("prefix", "Hello");
    cli.manager.register(
      defineCliController({
        command: "greeting read",
        input: z.object({ name: z.string() }),
        output: z.string().transform((value) => value.toUpperCase()),
        dependencies: {
          prefix: dep<string>("prefix"),
        },
        handler: ({ deps, input }) => `${deps.prefix} ${input.name}`,
      }),
    );

    const exitCode = await cli.manager.run([
      "greeting",
      "read",
      "--name=Ada",
    ]);

    expect(exitCode).toBe(0);
    expect(cli.output).toEqual(['"HELLO ADA"\n']);
  });

  it("runs CLI middleware around the handler and output validation", async () => {
    const events: string[] = [];
    const dependencies = {
      label: dep<string>("label"),
    } as const;
    const middleware = defineCliMiddleware<
      { name: string },
      typeof dependencies
    >(
      "test.cli",
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
    const cli = createTestCli();

    cli.app.container.registerValue("label", "cli");
    cli.manager.register(
      defineCliController({
        command: "middleware read",
        input: z.object({ name: z.string() }),
        output: z.string().transform((value) => value.toUpperCase()),
        middleware: [middleware],
        handler: ({ input }) => {
          events.push("handler");

          return input.name;
        },
      }),
    );

    const exitCode = await cli.manager.run([
      "middleware",
      "read",
      "--name=Ada",
    ]);

    expect(exitCode).toBe(0);
    expect(cli.output).toEqual(['"ADA"\n']);
    expect(events).toEqual([
      "before:cli:Ada",
      "handler",
      "after",
    ]);

    await cli.app.dispose();
  });

  it("runs a nested action command with default option bindings", async () => {
    const action = defineAction({
      name: "number.double",
      input: z.object({
        value: z.coerce.number().int(),
      }),
      output: z.object({
        value: z.number().int(),
      }),
      description: "Double a number.",
      handler: ({ value }) => ({ value: value * 2 }),
    });
    const controller = defineActionCliController(
      action,
      "number double",
    );
    const cli = createTestCli();

    cli.manager.register(controller);

    const exitCode = await cli.manager.run([
      "number",
      "double",
      "--value=4",
    ]);

    expect(exitCode).toBe(0);
    expect(controller.description).toBe("Double a number.");
    expect(cli.output).toEqual([
      '{\n  "value": 8\n}\n',
    ]);
    expect(cli.errors).toEqual([]);
  });

  it("allows a controller to override its action description", () => {
    const action = defineAction({
      name: "description.read",
      input: z.object({}),
      output: z.string(),
      description: "Action description.",
      handler: () => "result",
    });
    const controller = defineActionCliController(
      action,
      "description read",
      {
        description: "Controller description.",
      },
    );

    expect(controller.description).toBe(
      "Controller description.",
    );
  });

  it("prints compact JSON when requested", async () => {
    const action = defineAction({
      name: "value.read",
      input: z.object({}),
      output: z.object({ value: z.string() }),
      handler: () => ({ value: "compact" }),
    });
    const cli = createTestCli();

    cli.manager.register(
      defineActionCliController(action, "value read"),
    );

    const exitCode = await cli.manager.run([
      "value",
      "read",
      "--_format=json",
    ]);

    expect(exitCode).toBe(0);
    expect(cli.output).toEqual([
      '{"value":"compact"}\n',
    ]);
  });

  it("supports positional and explicitly named bindings", async () => {
    const action = defineAction({
      name: "greeting.create",
      input: z.object({
        name: z.string(),
        greeting: z.string(),
      }),
      output: z.string(),
      handler: ({ greeting, name }) =>
        `${greeting} ${name}`,
    });
    const controller = defineActionCliController(
      action,
      "greeting create",
      {
        bindings: {
          name: param(0),
          greeting: option("message"),
        },
      },
    );
    const cli = createTestCli();

    cli.manager.register(controller);

    const exitCode = await cli.manager.run([
      "greeting",
      "create",
      "Ada",
      "--message=Hello",
    ]);

    expect(exitCode).toBe(0);
    expect(cli.output).toEqual(['"Hello Ada"\n']);
  });

  it("shares scoped dependencies between actions in one command", async () => {
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
    const cli = createTestCli();

    cli.app.container.registerFactory(
      "resource",
      () => ({}),
      {
        lifetime: "scoped",
        dispose,
      },
    );
    cli.manager.register(
      defineActionCliController(firstAction, "scope read", {
        handler: async ({ action, execution, input }) => {
          const first = await action.run(input);
          const second = await execution
            .get(secondAction)
            .run(input);

          return first === second ? "shared" : "different";
        },
      }),
    );

    const exitCode = await cli.manager.run([
      "scope",
      "read",
    ]);

    expect(exitCode).toBe(0);
    expect(cli.output).toEqual(['"shared"\n']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns code 2 for input validation errors", async () => {
    const action = defineAction({
      name: "number.positive",
      input: z.object({
        value: z.coerce.number().positive(),
      }),
      output: z.number(),
      handler: ({ value }) => value,
    });
    const cli = createTestCli();

    cli.manager.register(
      defineActionCliController(action, "number positive"),
    );

    const exitCode = await cli.manager.run([
      "number",
      "positive",
      "--value=invalid",
    ]);

    expect(exitCode).toBe(2);
    expect(cli.output).toEqual([]);
    expect(cli.errors.join("")).toContain(
      "Invalid command input",
    );
  });

  it("returns code 1 and hides action errors with the safe default handler", async () => {
    const action = defineAction({
      name: "failure.run",
      input: z.object({}),
      output: z.never(),
      handler: () => {
        throw new Error("Action failed");
      },
    });
    const cli = createTestCli();

    cli.manager.register(
      defineActionCliController(action, "failure run"),
    );

    const exitCode = await cli.manager.run([
      "failure",
      "run",
    ]);

    expect(exitCode).toBe(1);
    expect(cli.errors).toHaveLength(1);
    expect(cli.errors[0]).toMatch(
      /^An unexpected error occurred\. Execution: .+\n$/,
    );
  });

  it("prints the cause chain for wrapped execution errors", async () => {
    const databaseError = new Error(
      'relation "users" does not exist',
    );
    const action = defineAction({
      name: "failure.wrapped",
      input: z.object({}),
      output: z.never(),
      handler: () => {
        throw new Error("Failed query: insert into users", {
          cause: databaseError,
        });
      },
    });
    const cli = createTestCli();

    cli.app.container.registerValue(
      "errorHandler",
      new DefaultErrorHandler({ debug: true }),
    );

    cli.manager.register(
      defineActionCliController(action, "failure wrapped"),
    );

    const exitCode = await cli.manager.run([
      "failure",
      "wrapped",
    ]);

    expect(exitCode).toBe(1);
    expect(cli.errors).toHaveLength(1);
    expect(cli.errors[0]).toMatch(
      /Error: Failed query: insert into users[\s\S]+Caused by: Error: relation "users" does not exist/,
    );
  });

  it("uses the exit code and message exposed by an expected CLI error", async () => {
    class UnavailableError extends Error implements CliRepresentableError {
      public toCliError() {
        return {
          exitCode: 4,
          message: "The service is temporarily unavailable.",
        };
      }
    }

    const action = defineAction({
      name: "unavailable.run",
      input: z.object({}),
      output: z.never(),
      handler: () => {
        throw new UnavailableError("Internal details");
      },
    });
    const cli = createTestCli();

    cli.manager.register(
      defineActionCliController(action, "unavailable run"),
    );

    const exitCode = await cli.manager.run([
      "unavailable",
      "run",
    ]);

    expect(exitCode).toBe(4);
    expect(cli.errors).toEqual([
      "The service is temporarily unavailable.\n",
    ]);
  });

  it("returns code 2 for unknown commands", async () => {
    const cli = createTestCli();

    const exitCode = await cli.manager.run(["unknown"]);

    expect(exitCode).toBe(2);
    expect(cli.errors.join("")).toContain("error:");
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
