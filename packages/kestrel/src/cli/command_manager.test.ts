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

function createTestCli(): TestCli {
  const output: string[] = [];
  const errors: string[] = [];
  const app = new App({});
  const manager = new CliCommandManager(app, {
    name: "test",
    writeOutput: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  });

  return { app, manager, output, errors };
}

describe("CliCommandManager", () => {
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

  it("records the lifecycle of a CLI execution", async () => {
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
      handler: () => {
        expect(observerContext.get()).toBeDefined();

        return { status: "ok" };
      },
    }));

    const exitCode = await cli.manager.run(["observed", "run"]);

    expect(exitCode).toBe(0);
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
      outcome: "success",
      data: {
        operation: "observed run",
        transport: "cli",
      },
    });
  });

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
