import { describe, expect, it, vi } from "vitest";

import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { defineSubjectRoleStorageAdapter } from "../../adapter_definition.js";
import { MemorySubjectRoleStorageAdapter } from "../../adapters/memory/index.js";
import { definePermission, defineRole } from "../../definition.js";
import { permissionResolverDependency, subjectRoleStoreDependency } from "../../dependencies.js";
import { rolePermissions } from "./definition.js";
import { RolePermissionResolver } from "./resolver.js";
import { RolePermissionResolverProvider } from "./provider.js";

const read = definePermission({ id: "records.read" });
const write = definePermission({ id: "records.write" });
const reader = defineRole({ key: "reader", name: "Reader", permissions: [read] });
const writer = defineRole({ key: "writer", name: "Writer", permissions: [read, write] });

describe("RolePermissionResolver", () => {
  it("unions code-defined permissions and reloads grants on every resolution", async () => {
    const subjectRoleStore = new MemorySubjectRoleStorageAdapter();
    const resolver = new RolePermissionResolver({ roles: [reader, writer], subjectRoleStore });
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set());
    await subjectRoleStore.grantRole("subject-1", reader.key);
    await subjectRoleStore.grantRole("subject-1", writer.key);
    await subjectRoleStore.grantRole("subject-1", "removed-role");
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set([read.id, write.id]));
    await expect(resolver.resolvePermissions("subject-2")).resolves.toEqual(new Set());
    await subjectRoleStore.revokeRole("subject-1", writer.key);
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set([read.id]));
    await subjectRoleStore.revokeRole("subject-1", reader.key);
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set());
  });

  it("rejects duplicate role keys and invalid definitions before resolution", () => {
    const subjectRoleStore = new MemorySubjectRoleStorageAdapter();
    expect(() => new RolePermissionResolver({ roles: [reader, reader], subjectRoleStore }))
      .toThrow('Authorization role "reader" is declared more than once.');
    expect(() => new RolePermissionResolverProvider([reader, reader], defineSubjectRoleStorageAdapter({ dependencies: {}, capabilities: {}, create: () => ({ listRoleKeys: async () => new Set<string>(), grantRole: async () => true, revokeRole: async () => true }) }))).toThrow(TypeError);
    expect(() => new RolePermissionResolver({
      roles: [{ ...reader, permissions: [{ id: "Invalid Permission" }] }], subjectRoleStore,
    })).toThrow(TypeError);
  });

  it("snapshots nested definitions and never leaks a mutable effective set", async () => {
    const subjectRoleStore = new MemorySubjectRoleStorageAdapter();
    const mutablePermission = { id: read.id };
    const mutableRole = { key: "reader", name: "Reader", permissions: [mutablePermission] };
    const roles = [mutableRole];
    const resolver = new RolePermissionResolver({ roles, subjectRoleStore });
    mutablePermission.id = write.id;
    mutableRole.permissions.push(write);
    roles.push({ key: "injected", name: "Injected", permissions: [write] });
    await subjectRoleStore.grantRole("subject-1", "reader");
    await subjectRoleStore.grantRole("subject-1", "injected");
    const effective = await resolver.resolvePermissions("subject-1") as Set<string>;
    expect(effective).toEqual(new Set([read.id]));
    effective.add(write.id);
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set([read.id]));
  });

  it("propagates assignment-store failures instead of reporting an ordinary denial", async () => {
    const failure = new Error("assignment store unavailable");
    const subjectRoleStore = new MemorySubjectRoleStorageAdapter();
    const list = vi.spyOn(subjectRoleStore, "listRoleKeys").mockRejectedValue(failure);
    const resolver = new RolePermissionResolver({ roles: [reader], subjectRoleStore });
    await expect(resolver.resolvePermissions("subject-1")).rejects.toBe(failure);
    expect(list).toHaveBeenCalledWith("subject-1");
  });

  it("disposes only the storage instance owned by a resolver and only once", async () => {
    const firstStore = new MemorySubjectRoleStorageAdapter();
    const secondStore = new MemorySubjectRoleStorageAdapter();
    const create = vi.fn()
      .mockReturnValueOnce(firstStore)
      .mockReturnValueOnce(secondStore);
    const dispose = vi.fn();
    const definition = rolePermissions([reader], defineSubjectRoleStorageAdapter({
      dependencies: {},
      capabilities: {},
      create,
      dispose,
    }));
    const unexpectedDependency = (): never => { throw new Error("Unexpected dependency"); };
    const first = definition.create(unexpectedDependency);
    const second = definition.create(unexpectedDependency);

    try {
      await firstStore.grantRole("subject-1", reader.key);
      await expect(first.resolvePermissions("subject-1")).resolves.toEqual(new Set([read.id]));
      await expect(second.resolvePermissions("subject-1")).resolves.toEqual(new Set());
      await definition.dispose(first);
      await definition.dispose(first);
      expect(dispose).toHaveBeenCalledExactlyOnceWith(firstStore);
      await definition.dispose(second);
      expect(dispose.mock.calls).toEqual([[firstStore], [secondStore]]);
    } finally {
      await definition.dispose(first);
      await definition.dispose(second);
    }
  });

  it("rejects asynchronous child storage before composing the scoped resolver", () => {
    const create = vi.fn(() => new MemorySubjectRoleStorageAdapter());
    const initialize = vi.fn(async () => {});
    const storage = defineSubjectRoleStorageAdapter({ dependencies: {}, capabilities: {}, create });

    // A JavaScript adapter can supply an initialize hook despite the scoped TypeScript contract.
    expect(() => Reflect.apply(rolePermissions, undefined, [[reader], { ...storage, initialize }]))
      .toThrow("Scoped authorization assignment stores must be synchronously ready.");
    expect(create).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("resolves the registered role catalog and store once per execution", async () => {
    const app = new App({});
    const source = dep<MemorySubjectRoleStorageAdapter>("executionRoleSource");
    const create = vi.fn(({ source }: { source: MemorySubjectRoleStorageAdapter }) => source);
    const dispose = vi.fn();
    const permissions = [{ id: read.id }];
    const role = { key: reader.key, name: reader.name, permissions };

    try {
      app.container.registerFactory(source.id, () => new MemorySubjectRoleStorageAdapter(), { lifetime: "scoped" });
      app.register(new RolePermissionResolverProvider([role], defineSubjectRoleStorageAdapter({
        dependencies: { source }, capabilities: {}, create, dispose,
      })));
      // The provider owns a catalog snapshot even before the first execution is opened.
      permissions[0]!.id = write.id;
      await app.start();
      expect(create).not.toHaveBeenCalled();
      for (let index = 0; index < 2; index++) {
        const execution = await app.createExecutionScope();
        try {
          const store = execution.container.resolve(subjectRoleStoreDependency);
          const resolver = execution.container.resolve(permissionResolverDependency);
          expect(execution.container.resolve(subjectRoleStoreDependency)).toBe(store);
          expect(execution.container.resolve(permissionResolverDependency)).toBe(resolver);
          expect(store).toBe(execution.container.resolve(source));
          await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set());
          await store.grantRole("subject-1", reader.key);
          await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set([read.id]));
        } finally {
          await execution.dispose();
        }
      }
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.results[0]?.value).not.toBe(create.mock.results[1]?.value);
      expect(dispose.mock.calls).toEqual(create.mock.results.map(({ value }) => [value]));
    } finally {
      await app.dispose();
    }
  });
});
