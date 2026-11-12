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
    expect(role.description).toBe("Manage the application");
    expect(role.permissions[0]?.description).toBe("Open administration");
  });

  it("rejects invalid and ambiguous definitions", () => {
    expect(() => definePermission({ id: "Admin Access" })).toThrow(TypeError);
    expect(() => allOf()).toThrow(TypeError);
    expect(() => anyOf()).toThrow(TypeError);
    const access = definePermission({ id: "admin.access" });
    expect(() => defineRole({
      key: "admin",
      name: "Administrator",
      permissions: [access, access],
    })).toThrow(TypeError);
    expect(() => defineRole({
      key: "admin",
      name: " \t ",
      permissions: [access],
    })).toThrow("Role name must not be empty");
  });
});
