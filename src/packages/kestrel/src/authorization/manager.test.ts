import { describe, expect, it, vi } from "vitest";

import { AuthenticationContext } from "../authentication/index.js";
import { AuthenticationRequiredError } from "../authentication/errors.js";
import { AuthorizationDeniedError } from "./errors.js";
import { AuthorizationManager } from "./manager.js";
import { allOf, anyOf, permission } from "./requirements.js";
import { definePermission } from "./definition.js";

const read = definePermission({ id: "records.read" });
const write = definePermission({ id: "records.write" });
const archive = definePermission({ id: "records.archive" });

describe("AuthorizationManager", () => {
  it("keeps the declared permission when its caller mutates the source object", async () => {
    const source = { id: write.id };
    const requirement = permission(source);
    const manager = new AuthorizationManager({
      authenticationContext: authenticatedContext("subject-1"),
      permissionResolver: { resolvePermissions: async () => new Set([read.id]) },
    });

    // A later caller mutation cannot grant access to a subject missing the original permission.
    source.id = read.id;
    await expect(manager.require(requirement)).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("grants and enforces an allOf requirement when every permission is present", async () => {
    const requirement = allOf(permission(read), permission(write));
    const manager = new AuthorizationManager({
      authenticationContext: authenticatedContext("subject-1"),
      permissionResolver: { resolvePermissions: async () => new Set([read.id, write.id]) },
    });

    const decision = await manager.check(requirement);
    expect(decision).toEqual({ allowed: true, requirement, reason: "granted" });
    expect(decision.requirement).toBe(requirement);
    expect(Object.isFrozen(decision)).toBe(true);
    await expect(manager.require(requirement)).resolves.toBeUndefined();
  });

  for (const granted of [true, false]) {
    it(`${granted ? "grants" : "denies"} a nested conjunction according to every branch`, async () => {
      // One disjunction may pass while the outer conjunction must still reject a missing permission.
      const requirement = allOf(
        anyOf(permission(read), permission(archive)),
        permission(write),
      );
      const manager = new AuthorizationManager({
        authenticationContext: authenticatedContext("subject-1"),
        permissionResolver: { resolvePermissions: async () => new Set(granted ? [archive.id, write.id] : [archive.id]) },
      });

      expect(await manager.check(requirement)).toEqual({
        allowed: granted,
        requirement,
        reason: granted ? "granted" : "missing-permission",
      });
      if (granted) await expect(manager.require(requirement)).resolves.toBeUndefined();
      else await expect(manager.require(requirement)).rejects.toBeInstanceOf(AuthorizationDeniedError);
    });
  }

  it("retains an execution-owned permission snapshot after the resolver's set changes", async () => {
    const permissions = new Set([read.id, write.id]);
    const resolvePermissions = vi.fn(async () => permissions);
    const manager = new AuthorizationManager({
      authenticationContext: authenticatedContext("subject-1"),
      permissionResolver: { resolvePermissions },
    });

    await expect(manager.check(permission(read))).resolves.toMatchObject({ allowed: true });
    // Mutating a resolver's backing collection must not change this execution's decisions.
    permissions.delete(write.id);
    permissions.add(archive.id);
    await expect(manager.require(allOf(permission(read), permission(write)))).resolves.toBeUndefined();
    await expect(manager.check(permission(archive))).resolves.toMatchObject({ allowed: false, reason: "missing-permission" });
    expect(resolvePermissions).toHaveBeenCalledExactlyOnceWith("subject-1");
  });

  it("evaluates permission expressions and resolves once per execution", async () => {
    const context = authenticatedContext("subject-1");
    const resolvePermissions = vi.fn(async () => new Set([read.id]));
    const manager = new AuthorizationManager({
      authenticationContext: context,
      permissionResolver: { resolvePermissions },
    });

    await expect(manager.check(permission(read))).resolves.toMatchObject({
      allowed: true,
      reason: "granted",
    });
    await expect(manager.check(allOf(
      permission(read),
      permission(write),
    ))).resolves.toMatchObject({ allowed: false });
    await expect(manager.check(anyOf(
      permission(read),
      permission(write),
    ))).resolves.toMatchObject({ allowed: true });
    expect(resolvePermissions).toHaveBeenCalledOnce();
    expect(resolvePermissions).toHaveBeenCalledWith("subject-1");
  });

  it("distinguishes missing authentication from denied authorization", async () => {
    const anonymous = new AuthorizationManager({
      authenticationContext: new AuthenticationContext(),
      permissionResolver: { resolvePermissions: async () => new Set() },
    });
    const denied = new AuthorizationManager({
      authenticationContext: authenticatedContext("subject-1"),
      permissionResolver: { resolvePermissions: async () => new Set() },
    });

    await expect(anonymous.require(permission(read)))
      .rejects.toBeInstanceOf(AuthenticationRequiredError);
    await expect(denied.require(permission(read)))
      .rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("fails closed when permission resolution fails", async () => {
    const failure = new Error("resolver unavailable");
    const manager = new AuthorizationManager({
      authenticationContext: authenticatedContext("subject-1"),
      permissionResolver: {
        resolvePermissions: async () => Promise.reject(failure),
      },
    });

    await expect(manager.require(permission(read))).rejects.toBe(failure);
  });
});

function authenticatedContext(subjectId: string): AuthenticationContext<{}> {
  const context = new AuthenticationContext<{}>();
  context.resolveAuthenticated({
    accountId: "account-1",
    subjectId,
    sessionId: "session-1",
    claims: {},
    authentication: {
      methods: ["password"],
      factors: ["knowledge"],
      authenticatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  return context;
}
