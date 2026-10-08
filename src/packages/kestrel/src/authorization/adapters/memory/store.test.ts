import { describe, expect, it } from "vitest";

import { MemorySubjectRoleStorageAdapter } from "./store.js";

describe("MemorySubjectRoleStorageAdapter", () => {
  it("isolates subjects and role keys with idempotent grants and revocations", async () => {
    const store = new MemorySubjectRoleStorageAdapter();
    await expect(store.listRoleKeys("unknown")).resolves.toEqual(new Set());
    await expect(store.grantRole("external|subject-1", "admin")).resolves.toBe(true);
    await expect(store.grantRole("external|subject-1", "admin")).resolves.toBe(false);
    await store.grantRole("external|subject-1", "editor");
    await store.grantRole("subject-2", "admin");
    await expect(store.revokeRole("external|subject-1", "admin")).resolves.toBe(true);
    await expect(store.revokeRole("external|subject-1", "admin")).resolves.toBe(false);
    await expect(store.listRoleKeys("external|subject-1")).resolves.toEqual(new Set(["editor"]));
    await expect(store.listRoleKeys("subject-2")).resolves.toEqual(new Set(["admin"]));
    await expect(store.revokeRole("unknown", "admin")).resolves.toBe(false);
  });

  it("does not expose mutable assignment state", async () => {
    const store = new MemorySubjectRoleStorageAdapter();
    await store.grantRole("subject-1", "admin");
    const keys = await store.listRoleKeys("subject-1") as Set<string>;
    keys.clear();
    await expect(store.listRoleKeys("subject-1")).resolves.toEqual(new Set(["admin"]));
  });
});
