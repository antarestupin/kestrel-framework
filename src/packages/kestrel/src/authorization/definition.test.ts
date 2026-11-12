import { describe, expect, it } from "vitest";

import { definePermission, defineRole } from "./definition.js";
import { allOf, anyOf, permission } from "./requirements.js";

describe("authorization definitions", () => {
  it("creates immutable permission, role and requirement values", () => {
    const access = definePermission({ id: "admin.access", description: "Open administration" });
    const role = defineRole({
      key: "admin",
      name: "Administrator",
      description: "Manage the application",
      permissions: [access],
    });
    const requirement = anyOf(permission(access));

    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(role.permissions)).toBe(true);
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(requirement).toStrictEqual({
      type: "any",
      requirements: [{ type: "permission", permission: access }],
    });
    expect(allOf(permission(access))).toStrictEqual({
      type: "all",
      requirements: [{ type: "permission", permission: access }],
    });
    expect(role.description).toBe("Manage the application");
    expect(role.permissions[0]?.description).toBe("Open administration");
  });

  it("rejects invalid and ambiguous definitions", () => {
    expect(() => definePermission({ id: "Admin Access" })).toThrow('Permission identifier "Admin Access"');
    expect(() => allOf()).toThrow("all authorization requirements must not be empty.");
    expect(() => anyOf()).toThrow("any authorization requirements must not be empty.");
    const access = definePermission({ id: "admin.access" });
    expect(() => defineRole({
      key: "admin",
      name: "Administrator",
      permissions: [access, access],
    })).toThrow('Role permission "admin.access" is declared more than once.');
    expect(() => defineRole({
      key: "admin",
      name: " \t ",
      permissions: [access],
    })).toThrow("Role name must not be empty");
  });

  it("enforces complete identifiers at the inclusive length boundary", () => {
    const id = "a".repeat(128);
    const malformed = "admin.access!";
    // Both definition types enforce the same grammar and length independently.
    expect(definePermission({ id })).toStrictEqual({ id });
    expect(defineRole({ key: id, name: "Administrator", permissions: [] }))
      .toStrictEqual({ key: id, name: "Administrator", permissions: [] });
    expect(() => definePermission({ id: malformed })).toThrow(`Permission identifier "${malformed}"`);
    expect(() => definePermission({ id: `${id}a` })).toThrow("at most 128 characters");
    expect(() => defineRole({ key: malformed, name: "Administrator", permissions: [] }))
      .toThrow(`Role identifier "${malformed}"`);
  });
});
