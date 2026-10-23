import { asFunction, type AwilixContainer } from "awilix";

import type { DependencyContainer, RegistrationOptions } from "./container.js";
import {
  normalizeDependency,
  type DependencyDeclaration,
  type DependencyDeclarations,
  type DependencyLifetime,
  type ResolvedDependencies,
} from "./dependencies.js";

interface AsyncFactory<Config> {
  readonly id: string;
  readonly dependencies: DependencyDeclarations<Config>;
  readonly create: (dependencies: Record<string, unknown>) => unknown;
  readonly lifetime: DependencyLifetime;
  readonly dispose: ((value: unknown) => void | Promise<void>) | undefined;
}

const lifetimeRank = { TRANSIENT: 0, SCOPED: 1, SINGLETON: 2 };

/** Owns asynchronous factory work and resources for one container scope. */
export class AsyncFactoryScope<Config> {
  private readonly cache = new Map<AsyncFactory<Config>, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources: Array<() => void | Promise<void>> = [];
  private disposal: Promise<void> | undefined;
  private closed = false;
  private readonly factories: WeakMap<object, AsyncFactory<Config>>;

  public constructor(
    private readonly owner: DependencyContainer<Config>,
    private readonly container: AwilixContainer,
    private readonly root?: AsyncFactoryScope<Config>,
  ) {
    // Resolver identity preserves ordinary scope overrides without a second
    // name registry; only scopes belonging to this root share definitions.
    this.factories = root?.factories ?? new WeakMap();
  }

  public get rootScope(): AsyncFactoryScope<Config> {
    return this.root ?? this;
  }

  public assertOpen(): void {
    if (this.closed) throw new Error("The dependency container is disposing or disposed.");
  }

  public register<Value, const Dependencies extends DependencyDeclarations<Config>>(
    id: string,
    dependencies: Dependencies,
    create: (dependencies: ResolvedDependencies<Dependencies>) => Value | Promise<Value>,
    options: RegistrationOptions<Value>,
  ): void {
    this.assertOpen();
    const lifetime = options.lifetime ?? "transient";
    // Synchronous consumers must never accidentally receive a Promise or a cell.
    const resolver = asFunction(() => {
      throw new Error(`Dependency "${id}" requires asynchronous resolution. Use resolveAsync() and registerAsyncFactory() for services that consume it.`);
    }).setLifetime(lifetime.toUpperCase() as "SINGLETON" | "SCOPED" | "TRANSIENT");
    const dispose = options.dispose;
    this.factories.set(resolver, {
      id,
      dependencies: Object.freeze({ ...dependencies }),
      create: (resolved) => create(resolved as ResolvedDependencies<Dependencies>),
      lifetime,
      dispose: dispose === undefined ? undefined : (value) => dispose(value as Value),
    });
    this.container.register(id, resolver);
  }

  public async resolve(declaration: DependencyDeclaration<Config, unknown>): Promise<unknown> {
    this.assertOpen();
    // Validate before consulting caches: concurrent entry points cannot deadlock
    // by each caching one side of a cycle before traversing the other side.
    this.validate(declaration, []);
    return this.resolveUnchecked(declaration);
  }

  private validate(
    declaration: DependencyDeclaration<Config, unknown>,
    path: readonly AsyncFactory<Config>[],
  ): void {
    const descriptor = normalizeDependency(declaration);
    if (descriptor.kind !== "registered") {
      if (descriptor.kind === "class" && path.some((factory) => factory.lifetime !== "transient")) {
        throw new Error("A cached async factory cannot capture an unregistered transient class. Register the class with an appropriate lifetime.");
      }
      return;
    }
    const resolver = this.container.getRegistration(descriptor.id);
    if (resolver === null) return; // Keep the normal missing-registration error.
    const factory = this.factories.get(resolver);
    const rank = lifetimeRank[resolver.lifetime ?? "TRANSIENT"];
    if (!resolver.isLeakSafe && path.some((ancestor) => lifetimeRank[ancestor.lifetime.toUpperCase() as keyof typeof lifetimeRank] > rank)) {
      throw new Error(`Dependency "${descriptor.id}" has a shorter lifetime than its async factory ancestor.`);
    }
    if (factory === undefined) return;
    if (path.includes(factory)) {
      throw new Error(`Cyclic asynchronous dependencies detected: ${[...path, factory].map((entry) => entry.id).join(" -> ")}.`);
    }
    const scope = factory.lifetime === "singleton" ? this.rootScope : this;
    scope.assertOpen();
    for (const dependency of Object.values(factory.dependencies)) {
      scope.validate(dependency, [...path, factory]);
    }
  }

  private resolveUnchecked(declaration: DependencyDeclaration<Config, unknown>): Promise<unknown> {
    const descriptor = normalizeDependency(declaration);
    const resolver = descriptor.kind === "registered"
      ? this.container.getRegistration(descriptor.id)
      : null;
    const factory = resolver === null ? undefined : this.factories.get(resolver);
    if (factory === undefined) {
      // Ordinary factories, classes and definition protocols stay synchronous.
      return Promise.resolve(this.owner.resolve(declaration));
    }
    const scope = factory.lifetime === "singleton" ? this.rootScope : this;
    const existing = scope.cache.get(factory);
    if (existing !== undefined) return existing;

    const work = Promise.resolve().then(async () => {
      const dependencies = await scope.resolveMap(factory.dependencies);
      const value = await factory.create(dependencies);
      if (factory.dispose !== undefined) {
        // Completion order puts consumers after their prerequisites; reverse it
        // during disposal, including owned transient instances.
        scope.resources.push(() => factory.dispose!(value));
      }
      return value;
    });
    if (factory.lifetime !== "transient") scope.cache.set(factory, work);
    scope.pending.add(work);
    // Observe both branches without creating an unhandled rejected Promise.
    void work.then(() => scope.pending.delete(work), () => scope.pending.delete(work));
    return work;
  }

  private async resolveMap(declarations: DependencyDeclarations<Config>): Promise<Record<string, unknown>> {
    const entries = Object.entries(declarations);
    const results = await Promise.allSettled(entries.map(async ([, declaration]) => this.resolveUnchecked(declaration)));
    // Wait for every sibling before propagating failure so scope cleanup cannot
    // release resources underneath an unfinished dependency initialization.
    return Object.fromEntries(entries.map(([name], index) => {
      const result = results[index]!;
      if (result.status === "rejected") throw result.reason;
      return [name, result.value];
    }));
  }

  public dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      const errors: unknown[] = [];
      for (const dispose of this.resources.reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      this.resources.length = 0;
      this.cache.clear();
      if (errors.length > 0) throw new AggregateError(errors, "Async dependency disposal failed.");
    })();
    return this.disposal;
  }
}
