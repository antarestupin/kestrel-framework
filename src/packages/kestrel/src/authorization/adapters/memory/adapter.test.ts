import { describe, expect, it } from "vitest";

import { definePermission, defineRole } from "../../definition.js";
import { MemoryAuthorizationAdapter } from "./adapter.js";

describe("MemoryAuthorizationAdapter", () => {
  it("resolves permissions through idempotent role grants", async () => {
    const access = definePermission({ id: "admin.access" });
    const adapter = new MemoryAuthorizationAdapter({
      createId: () => "role-1",
      roles: [defineRole({
        key: "admin",
        name: "Administrator",
        permissions: [access],
      })],
    });
    const role = await adapter.findRoleByKey("admin");

    expect(role).toBeDefined();
    await expect(adapter.grantRole("subject-1", role!.id)).resolves.toBe(true);
    await expect(adapter.grantRole("subject-1", role!.id)).resolves.toBe(false);
    await expect(adapter.resolvePermissions("subject-1"))
      .resolves.toEqual(new Set([access.id]));
    await expect(adapter.revokeRole("subject-1", role!.id)).resolves.toBe(true);
    await expect(adapter.resolvePermissions("subject-1"))
      .resolves.toEqual(new Set());
  });
});
