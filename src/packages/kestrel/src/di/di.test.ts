import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  createDependencyApi,
  createDependencyContainer,
  dep,
  fromConfig,
  normalizeDependency,
  resolveDependency,
  type ResolvableDependency,
} from "./index.js";

interface TestConfig {
  feature: {
    enabled: boolean;
  };
}

class GreetingService {
  public readonly greeting: string;

  public constructor({
    prefix,
  }: {
    prefix: string;
  }) {
    this.greeting = `${prefix} world`;
  }
}

class Instance {
  // Each construction gets a distinct identity without relying on timing.
  public readonly identity = {};
}

describe("dependency declarations", () => {
  it("normalizes concrete classes", () => {
    const descriptor = normalizeDependency(GreetingService);

    expect(descriptor).toMatchObject({
      kind: "class",
      target: GreetingService,
    });
  });

  it("declares named and configuration dependencies", () => {
    const registered = dep<Date>("clock");
    const { fromConfig: fromTestConfig } =
      createDependencyApi<TestConfig>();
    const configured = fromTestConfig(
      (config) => config.feature.enabled,
    );

    expect(registered).toMatchObject({
      kind: "registered",
      id: "clock",
    });
    expect(configured.kind).toBe("config");
    expectTypeOf(configured.selector).returns.toEqualTypeOf<boolean>();
  });
});

describe("DependencyContainer", () => {
  it("resolves protocol values in the current container without caching", async () => {
    const container = createDependencyContainer({});
    const scope = container.createScope();
    const definition = {
      label: "resolved",
      [resolveDependency](current) {
        return { label: this.label, value: current.resolve(dep<string>("value")) };
      },
    } satisfies ResolvableDependency<{}, { label: string; value: string }> & { label: string };
    container.registerValue("value", "root");
    scope.registerValue("value", "scope");

    try {
      const normalized = normalizeDependency(definition);
      const direct = scope.resolve(definition);
      const dependencies = scope.resolveDependencies({ definition });

      expect(normalized).toMatchObject({ kind: "resolvable", target: definition });
      expect(container.resolve(definition)).toEqual({ label: "resolved", value: "root" });
      expect(direct).toEqual({ label: "resolved", value: "scope" });
      expect(dependencies.definition).toEqual(direct);
      expect(dependencies.definition).not.toBe(direct);
      expect(scope.resolve(normalized)).toEqual(direct);
      expectTypeOf(direct).toEqualTypeOf<{ label: string; value: string }>();
      expectTypeOf(dependencies.definition).toEqualTypeOf<typeof direct>();
    } finally {
      await scope.dispose();
      await container.dispose();
    }
  });

  it("propagates protocol resolution failures", async () => {
    const container = createDependencyContainer({});
    const failure = new Error("Cannot resolve definition");
    try {
      expect(() => container.resolve({
        [resolveDependency]() {
          throw failure;
        },
      })).toThrow(failure);
    } finally {
      await container.dispose();
    }
  });

  it("resolves classes, named dependencies and configuration values", () => {
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const container = createDependencyContainer<TestConfig>({
      feature: { enabled: true },
    });

    container.registerValue("prefix", "hello");
    container.registerValue("clock", clock);

    const dependencies = container.resolveDependencies({
      greetingService: GreetingService,
      clock: dep<Date>("clock"),
      featureEnabled: fromConfig(
        (config: TestConfig) => config.feature.enabled,
      ),
    });

    expect(dependencies.greetingService.greeting).toBe("hello world");
    expect(container.resolve(GreetingService)).not.toBe(
      container.resolve(GreetingService),
    );
    expect(dependencies.clock).toBe(clock);
    expect(dependencies.featureEnabled).toBe(true);
    expectTypeOf(
      dependencies.greetingService,
    ).toEqualTypeOf<GreetingService>();
    expectTypeOf(dependencies.clock).toEqualTypeOf<Date>();
    expectTypeOf(
      dependencies.featureEnabled,
    ).toEqualTypeOf<boolean>();
  });

  it("checks registrations across a container scope hierarchy", () => {
    const container = createDependencyContainer({});
    const scope = container.createScope();

    expect(container.hasRegistration("service")).toBe(false);
    expect(scope.hasRegistration("service")).toBe(false);

    container.registerValue("service", {});

    expect(container.hasRegistration("service")).toBe(true);
    expect(scope.hasRegistration("service")).toBe(true);
  });

  it("honors singleton, scoped and transient lifetimes", () => {
    const container = createDependencyContainer({});

    container.registerClass("singleton", Instance, {
      lifetime: "singleton",
    });
    container.registerClass("scoped", Instance, {
      lifetime: "scoped",
    });
    container.registerClass("transient", Instance, {
      lifetime: "transient",
    });

    const scope = container.createScope();

    const rootSingleton = container.resolve(
      dep<Instance>("singleton"),
    );
    expect(
      scope.resolve(dep<Instance>("singleton")),
    ).toBe(rootSingleton);

    const rootScoped = container.resolve(dep<Instance>("scoped"));
    const scopeScoped = scope.resolve(dep<Instance>("scoped"));
    expect(container.resolve(dep<Instance>("scoped"))).toBe(
      rootScoped,
    );
    expect(scope.resolve(dep<Instance>("scoped"))).toBe(
      scopeScoped,
    );
    expect(scopeScoped).not.toBe(rootScoped);

    expect(
      container.resolve(dep<Instance>("transient")),
    ).not.toBe(container.resolve(dep<Instance>("transient")));
  });

  it("injects registered dependencies into factories", () => {
    const container = createDependencyContainer({});

    container.registerValue("prefix", "hello");
    container.registerFactory(
      "greeting",
      ({ prefix }: { prefix: string }) => `${prefix} world`,
      { lifetime: "scoped" },
    );

    expect(container.resolve(dep<string>("greeting"))).toBe(
      "hello world",
    );
  });

  it("disposes resources owned by the container", async () => {
    const dispose = vi.fn();
    const resource = {};
    const container = createDependencyContainer({});

    container.registerValue("resource", resource, { dispose });

    await container.dispose();

    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
  });

  it("reports missing named dependencies", () => {
    const container = createDependencyContainer({});

    expect(() =>
      container.resolve(dep("missing")),
    ).toThrowError(/Could not resolve 'missing'/);
  });
});
