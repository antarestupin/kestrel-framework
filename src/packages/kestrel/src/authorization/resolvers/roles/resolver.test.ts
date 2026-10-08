import type { SubjectRoleStorageAdapter } from "../../types.js";
import { defineSubjectRoleStorageAdapter } from "./../../index.js";
import { describe, expect, it, vi } from "vitest";

import { MemorySubjectRoleStorageAdapter } from "../../adapters/memory/index.js";
import { definePermission, defineRole } from "../../definition.js";
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
    expect(() => new RolePermissionResolver({ roles: [reader, reader], subjectRoleStore })).toThrow(TypeError);
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
});
