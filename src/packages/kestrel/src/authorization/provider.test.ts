import { expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { AuthenticationContext } from "../authentication/index.js";
import { dep } from "../di/index.js";
import { authorizationManagerDependency, permissionResolverDependency } from "./dependencies.js";
import { AuthorizationProvider } from "./provider.js";
import { definePermissionResolverAdapter } from "./resolver_definition.js";

it("shares an authorization manager and a custom resolver within each execution", async () => {
  const app = new App({});
  const source = dep<Set<string>>("executionPermissions");
  const create = vi.fn(({ source }: { source: Set<string> }) => ({
    resolvePermissions: async () => source,
  }));
  const dispose = vi.fn();

  try {
    app.container.registerFactory(source.id, () => new Set<string>(), { lifetime: "scoped" });
    app.container.registerFactory("authenticationContext", () => new AuthenticationContext(), { lifetime: "scoped" });
    app.register(new AuthorizationProvider(definePermissionResolverAdapter({
      dependencies: { source }, capabilities: {}, create, dispose,
    })));
    await app.start();
    expect(create).not.toHaveBeenCalled();

    // Resolving a second execution must not reuse the first manager or its permission snapshot.
    const first = await app.createExecutionScope();
    try {
      const second = await app.createExecutionScope();
      try {
        const firstManager = first.container.resolve(authorizationManagerDependency);
        const firstResolver = first.container.resolve(permissionResolverDependency);
        expect(first.container.resolve(authorizationManagerDependency)).toBe(firstManager);
        expect(first.container.resolve(permissionResolverDependency)).toBe(firstResolver);
        // Compare identity without inspecting the managers' DI cradles.
        expect(second.container.resolve(authorizationManagerDependency) === firstManager).toBe(false);
        expect(second.container.resolve(permissionResolverDependency)).not.toBe(firstResolver);
        expect(create).toHaveBeenCalledTimes(2);
      } finally {
        await second.dispose();
      }
    } finally {
      await first.dispose();
    }
    expect(dispose.mock.calls).toEqual(create.mock.results.map(({ value }) => [value]).reverse());
  } finally {
    await app.dispose();
  }
});
