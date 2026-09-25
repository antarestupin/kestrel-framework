import { describe, expect, it, vi } from "vitest";

import { AuthenticationContext } from "../authentication/index.js";
import { AuthenticationRequiredError } from "../authentication/errors.js";
import { AuthorizationDeniedError } from "./errors.js";
import { AuthorizationManager } from "./manager.js";
import { allOf, anyOf, permission } from "./requirements.js";
import { definePermission } from "./definition.js";

const read = definePermission({ id: "records.read" });
const write = definePermission({ id: "records.write" });

describe("AuthorizationManager", () => {
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
