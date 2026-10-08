import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  createDependencyContainer,
  dep,
  fromConfig,
} from "../di/index.js";
import {
  defineEvent,
  eventBusDependency,
} from "../events/index.js";
import { DefaultErrorHandler } from "../errors/index.js";
import {
  AsyncLocalObserverContext,
  BufferedObservationRecorder,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import {
  App,
  applicationStartedEvent,
  bootstrapCompletedEvent,
  bootstrapStartedEvent,
  executionCompletedEvent,
  executionContextDependency,
  executionStartedEvent,
  runtimeStartedEvent,
  runtimeStoppingEvent,
  shutdownCompletedEvent,
  shutdownStartedEvent,
  type Provider,
  type ProviderBootApp,
  type ProviderCompositionApp,
} from "./index.js";

interface TestConfig {
  name: string;
}

class MessageProvider implements Provider<TestConfig> {
  public register(app: ProviderCompositionApp<TestConfig>): void {
    app.container.registerFactory(
      "message",
      ({ config }: { config: TestConfig }) =>
        `Hello from ${config.name}`,
      { lifetime: "singleton" },
    );
  }
}

describe("App", () => {
  it("aggregates configuration and the dependency container", () => {
    const config = { name: "TestApp" };
    const app = new App(config);

    expect(app.config).toBe(config);
    expect(
      app.container.resolve(
        fromConfig((value: TestConfig) => value.name),
      ),
    ).toBe("TestApp");
    expect(app.container.resolve(eventBusDependency)).toBe(app.eventBus);
  });

  it("registers providers using a fluent API", () => {
    const app = new App<TestConfig>({ name: "TestApp" });

    const result = app.register(new MessageProvider());

    expect(result).toBe(app);
    expect(app.container.resolve(dep("message"))).toBe(
      "Hello from TestApp",
    );
  });

  it("exposes only phase-specific capabilities to provider hooks", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    let compositionApp: ProviderCompositionApp<TestConfig> | undefined;
    let bootApp: ProviderBootApp<TestConfig> | undefined;

    app.register({
      register(context) {
        compositionApp = context;
      },
      boot(context) {
        bootApp = context;
      },
    });

    expect(compositionApp).not.toBe(app);
    expect(Object.keys(compositionApp ?? {}).sort()).toEqual([
      "catalog",
      "config",
      "container",
      "eventBus",
      "httpExtensions",
      "runtime",
    ]);
    expect(compositionApp?.runtime).toBe(app);

    await app.start();

    expect(bootApp).not.toBe(app);
    expect(Object.keys(bootApp ?? {}).sort()).toEqual([
      "bootPlan",
      "container",
    ]);
    await app.dispose();
  });

  it("boots providers sequentially after composition", async () => {
    const transitions: string[] = [];
    const app = new App<TestConfig>({ name: "TestApp" });

    app.register({
      register() {
        transitions.push("first:register");
      },
      async boot() {
        await Promise.resolve();
        transitions.push("first:boot");
      },
    });
    app.register({
      register() {
        transitions.push("second:register");
      },
      boot(currentApp) {
        transitions.push(
          `second:boot:${currentApp.bootPlan.workloads.join(",")}`,
        );
      },
    });

    expect(transitions).toEqual(["first:register", "second:register"]);

    await app.start();

    expect(transitions).toEqual([
      "first:register",
      "second:register",
      "first:boot",
      "second:boot:",
    ]);
    await app.dispose();
  });

  it("reports one complete startup profile after the app starts", async () => {
    class TimingProvider implements Provider<TestConfig> {
      public register(): void {}

      public boot(): void {}
    }

    const app = new App<TestConfig>({ name: "TestApp" });
    const startups: unknown[] = [];

    app.eventBus.listen(applicationStartedEvent, (startup) => {
      startups.push(startup);
    });
    app.register(new TimingProvider());
    app.prepareBootPlan(["workers"], "standard", "background");
    await app.start();

    expect(startups).toEqual([{
      runtime: "background",
      durations: {
        bootstrapMs: expect.any(Number),
        compositionMs: expect.any(Number),
        totalMs: expect.any(Number),
        providers: {
          boot: [{
            durationMs: expect.any(Number),
            provider: "TimingProvider",
          }],
          composition: [{
            durationMs: expect.any(Number),
            provider: "TimingProvider",
          }],
        },
      },
    }]);
    await app.dispose();
  });

  it("runs application lifecycle events in order and waits at boundaries", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const events: string[] = [];

    app.eventBus.listen(bootstrapStartedEvent, () => {
      events.push("bootstrap.started");
    });
    app.eventBus.listenAsync(bootstrapStartedEvent, async () => {
      await Promise.resolve();
      events.push("bootstrap.work.completed");
    });
    app.eventBus.listen(bootstrapCompletedEvent, () => {
      events.push("bootstrap.completed");
    });
    app.eventBus.listen(runtimeStartedEvent, () => {
      events.push("runtime.started");
    });
    app.eventBus.listen(runtimeStoppingEvent, () => {
      events.push("runtime.stopping");
    });
    app.eventBus.listen(shutdownStartedEvent, () => {
      events.push("shutdown.started");
    });
    app.eventBus.listen(shutdownCompletedEvent, () => {
      events.push("shutdown.completed");
    });

    expect(app.state).toBe("composing");
    await app.start();
    expect(app.state).toBe("running");
    await app.dispose();

    expect(app.state).toBe("disposed");
    expect(events).toEqual([
      "bootstrap.started",
      "bootstrap.work.completed",
      "bootstrap.completed",
      "runtime.started",
      "runtime.stopping",
      "shutdown.started",
      "shutdown.completed",
    ]);
  });

  it("rejects execution admission during composition and bootstrap", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    let releaseBootstrap = (): void => undefined;
    const bootstrapBlocked = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });

    await expect(app.createExecutionScope())
      .rejects.toThrow("application is composing");
    app.eventBus.listenAsync(bootstrapStartedEvent, async () => {
      await bootstrapBlocked;
    });

    const starting = app.start();
    await vi.waitFor(() => expect(app.state).toBe("bootstrapping"));
    await expect(app.createExecutionScope())
      .rejects.toThrow("application is bootstrapping");

    releaseBootstrap();
    await starting;
    await app.dispose();
  });

  it("opens execution admission only after runtime start listeners settle", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    let releaseRuntimeStart = (): void => undefined;
    const runtimeStartBlocked = new Promise<void>((resolve) => {
      releaseRuntimeStart = resolve;
    });

    app.eventBus.listenAsync(runtimeStartedEvent, async () => {
      await runtimeStartBlocked;
    });

    const starting = app.start();
    await vi.waitFor(() => expect(app.state).toBe("ready"));
    await expect(app.createExecutionScope())
      .rejects.toThrow("application is ready");

    releaseRuntimeStart();
    await starting;
    const execution = await app.createExecutionScope();
    await execution.dispose();
    await app.dispose();
  });

  it("rejects execution admission throughout stopping and shutdown", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    let releaseStopping = (): void => undefined;
    const stoppingBlocked = new Promise<void>((resolve) => {
      releaseStopping = resolve;
    });

    app.eventBus.listenAsync(runtimeStoppingEvent, async () => {
      await stoppingBlocked;
    });
    await app.start();
    const activeExecution = await app.createExecutionScope();

    const stopping = app.stop();
    expect(app.state).toBe("stopping");
    await expect(app.createExecutionScope())
      .rejects.toThrow("application is stopping");
    releaseStopping();
    await stopping;

    const disposing = app.dispose();
    await vi.waitFor(() => expect(app.state).toBe("shuttingDown"));
    await expect(app.createExecutionScope())
      .rejects.toThrow("application is shuttingDown");
    await activeExecution.dispose();
    await disposing;

    await expect(app.createExecutionScope())
      .rejects.toThrow("application is disposed");
  });

  it("rejects execution admission after failed bootstrap", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });

    app.register({
      register() {},
      boot() {
        throw new Error("Bootstrap failed.");
      },
    });

    await expect(app.start()).rejects.toThrow("Bootstrap failed.");
    expect(app.state).toBe("failed");
    await expect(app.createExecutionScope())
      .rejects.toThrow("application is failed");
    await app.dispose();
  });

  it("announces initialized executions and rejects new work while stopping", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const events: string[] = [];

    app.eventBus.listen(executionStartedEvent, (event) => {
      events.push(`started:${event.executionId}`);
    }, { scope: "descendants" });
    app.eventBus.listen(executionCompletedEvent, (event) => {
      events.push(`completed:${event.executionId}:${event.outcome}`);
    }, { scope: "descendants" });

    await app.start();
    const execution = await app.createExecutionScope("execution-1");
    await execution.dispose("failure");
    const disposing = app.dispose();

    await expect(app.createExecutionScope("execution-2"))
      .rejects.toThrow("Cannot create an execution");
    await disposing;

    expect(events).toEqual([
      "started:execution-1",
      "completed:execution-1:failure",
    ]);
  });

  it("keeps application resources alive until active executions drain", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const shutdownStarted = vi.fn();
    let applicationDisposed = false;

    app.eventBus.listen(shutdownStartedEvent, shutdownStarted);
    app.container.registerValue("resource", {}, {
      dispose: () => {
        applicationDisposed = true;
      },
    });

    await app.start();
    const execution = await app.createExecutionScope("execution-1");
    const disposing = app.dispose();

    await vi.waitFor(() => expect(app.state).toBe("shuttingDown"));
    expect(shutdownStarted).not.toHaveBeenCalled();
    expect(applicationDisposed).toBe(false);

    await execution.dispose();
    await disposing;

    expect(shutdownStarted).toHaveBeenCalledOnce();
    expect(applicationDisposed).toBe(true);
  });

  it("rejects provider registration after composition", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });

    await app.start();

    expect(() => app.register(new MessageProvider()))
      .toThrow("Providers can only be registered during composition.");
    await app.dispose();
  });

  it("finalizes one immutable boot plan before providers boot", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const plan = app.bootPlan;

    app.prepareBootPlan(
      ["http", "workers", "http"],
      "minimal",
      "server",
    );

    expect(app.bootPlan).toBe(plan);
    expect(app.bootPlan).toEqual({
      workloads: ["http", "workers"],
      runningMode: "minimal",
      runtime: "server",
    });

    await app.start();
    expect(() => app.prepareBootPlan([], "standard"))
      .toThrow("The boot plan must be selected during composition.");
    await app.dispose();
  });

  it("preserves an error handler registered before construction", async () => {
    const config = { name: "TestApp" };
    const container = createDependencyContainer(config);
    const errorHandler = new DefaultErrorHandler({ debug: true });

    container.registerValue("errorHandler", errorHandler);

    const app = new App(config, { container });
    await app.start();
    const execution = await app.createExecutionScope();

    expect(execution.errorHandler).toBe(errorHandler);

    await execution.dispose();
    await app.dispose();
  });

  it("disposes resources owned by providers", async () => {
    const dispose = vi.fn();
    const app = new App<TestConfig>({ name: "TestApp" });

    app.register({
      register(currentApp) {
        currentApp.container.registerValue(
          "resource",
          {},
          { dispose },
        );
      },
    });

    await app.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("flushes observations before shared resources are disposed", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    let databaseClosed = false;
    const append = vi.fn(async () => {
      if (databaseClosed) {
        throw new Error("The database pool is already closed.");
      }
    });
    const recorder = new BufferedObservationRecorder(
      { append },
      {
        batchSize: 50,
        flushIntervalMs: 60_000,
        onError: vi.fn(),
      },
    );

    // Registration order matches PostgresDrizzleProvider then ObservationProvider.
    app.container.registerValue(
      "databaseResource",
      {},
      { dispose: () => { databaseClosed = true; } },
    );
    app.container.registerValue(
      "observationRecorder",
      recorder,
      { dispose: (resource) => resource.close() },
    );
    recorder.enqueue({
      id: "00000000-0000-4000-8000-000000000001",
      executionId: "execution-1",
      occurredAt: new Date("2026-08-07T10:00:00.000Z"),
      name: "execution.started",
      category: "execution",
      schemaVersion: 1,
      data: { operation: "example", transport: "cli" },
    });

    await app.dispose();

    expect(append).toHaveBeenCalledOnce();
    expect(databaseClosed).toBe(true);
  });

  it("exposes one contextual identifier per execution scope", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    await app.start();
    const firstExecution = await app.createExecutionScope();
    const secondExecution = await app.createExecutionScope();

    expect(
      firstExecution.container.resolve(
        dep<string>("executionId"),
      ),
    ).toBe(firstExecution.id);
    expect(
      firstExecution.container.resolve(executionContextDependency),
    ).toBe(firstExecution.context);
    expect(firstExecution.context.entries()).toEqual([{
      key: "executionId",
      value: firstExecution.id,
      destinations: ["log", "observation"],
    }]);
    expect(secondExecution.context).not.toBe(firstExecution.context);
    expect(secondExecution.id).not.toBe(firstExecution.id);
    expect(
      firstExecution.container.resolve(eventBusDependency),
    ).toBe(firstExecution.eventBus);
    expect(firstExecution.eventBus?.scope).toMatchObject({
      id: firstExecution.id,
      kind: "execution",
      parent: app.eventBus.scope,
    });

    await firstExecution.dispose();
    await secondExecution.dispose();
    await app.dispose();
  });

  it("applies configured diagnostic limits to every execution context", async () => {
    const app = new App<TestConfig>({ name: "TestApp" }, {
      executionContext: {
        maxEntrySizeBytes: 100,
        maxTotalSizeBytes: 60,
      },
    });
    await app.start();
    const execution = await app.createExecutionScope();

    expect(() => execution.context.setDiagnostic("extra", true))
      .toThrow("total limit");

    await execution.dispose();
    await app.dispose();
  });

  it("drains scoped event work before disposing execution resources", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    await app.start();
    const execution = await app.createExecutionScope("execution-1");
    const scopedBus = execution.container.resolve(eventBusDependency);
    const postExecutionEvent = defineEvent({
      name: "test.postExecution",
      schema: z.null(),
    });
    let resourceDisposed = false;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const usedResource = vi.fn();

    execution.container.registerFactory("testResource", () => ({}), {
      lifetime: "scoped",
      dispose: () => { resourceDisposed = true; },
    });
    execution.container.resolve(dep("testResource"));
    scopedBus.listen(executionCompletedEvent, () => {
      scopedBus.dispatch(postExecutionEvent, null);
    });
    scopedBus.listenAsync(postExecutionEvent, async () => {
      await blocked;
      expect(resourceDisposed).toBe(false);
      usedResource();
    });

    const disposing = execution.dispose();
    await vi.waitFor(() => expect(execution.tasks.pendingCount).toBe(1));

    expect(resourceDisposed).toBe(false);
    release();
    await disposing;

    expect(usedResource).toHaveBeenCalledOnce();
    expect(resourceDisposed).toBe(true);
    await app.dispose();
  });

  it("exposes execution completion to global descendant listeners", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const ended = vi.fn();

    app.eventBus.listen(executionCompletedEvent, ended, {
      scope: "descendants",
    });
    await app.start();
    const execution = await app.createExecutionScope("execution-1");

    await execution.dispose();

    expect(ended).toHaveBeenCalledWith(
      {
        executionId: "execution-1",
        outcome: "success",
        context: execution.context,
      },
      { scope: execution.eventBus?.scope },
    );
    await app.dispose();
  });

  it("exposes the scoped observer to singleton instrumentation", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const context = new AsyncLocalObserverContext();
    const events: ObservationEvent[] = [];
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };
    const action = defineAction({
      name: "observation-context.read",
      dependencies: { observerContext: dep("observerContext") },
      handler: (_input, { observerContext }) => {
        expect(observerContext).toBe(context);
        expect(context.get()).toBeDefined();

        return null;
      },
    });

    app.container.registerValue("observationRecorder", recorder);
    app.container.registerValue("observerContext", context);
    app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );

    await app.get(action).run(null);

    expect(context.get()).toBeUndefined();
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "execution.completed",
    ]);

    await app.dispose();
  });

  it("adds tagged context values to the direct completion observation", async () => {
    const app = new App<TestConfig>({ name: "TestApp" });
    const events: ObservationEvent[] = [];
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => emptyRecorderHealth(),
    };
    const action = defineAction({
      name: "execution-context.write",
      dependencies: { executionContext: executionContextDependency },
      handler: (_input, { executionContext }) => {
        executionContext.setDiagnostic("userId", "user-1", {
          destinations: ["observation"],
        });
        executionContext.set("private", true);

        return null;
      },
    });

    app.container.registerValue("observationRecorder", recorder);
    app.container.registerValue(
      "observerContext",
      new AsyncLocalObserverContext(),
    );
    app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );

    await app.get(action).run(null);

    expect(events.at(-1)?.data).toEqual({
      operation: "execution-context.write",
      transport: "direct",
      context: { userId: "user-1" },
    });

    await app.dispose();
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
