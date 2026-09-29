import { describe, expect, it } from "vitest";

import { definePermission, defineRole } from "./definition.js";
import { allOf, anyOf, permission } from "./requirements.js";

describe("authorization definitions", () => {
  it("creates immutable permission, role and requirement values", () => {
    const access = definePermission({ id: "admin.access" });
    const role = defineRole({
      key: "admin",
      name: "Administrator",
      permissions: [access],
    });
    const requirement = anyOf(permission(access));

    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(role.permissions)).toBe(true);
    expect(Object.isFrozen(requirement)).toBe(true);
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
  });
});
