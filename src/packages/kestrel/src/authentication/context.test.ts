import { describe, expect, it } from "vitest";

import { AuthenticationContext } from "./context.js";

describe("AuthenticationContext", () => {
  it("resolves one immutable authenticated result", () => {
    const context = new AuthenticationContext<{ role: string }>();

    context.resolveAuthenticated({
      accountId: "account-1",
      subjectId: "subject-1",
      sessionId: "session-1",
      claims: { role: "member" },
      authentication: {
        methods: ["password"],
        factors: ["knowledge"],
        authenticatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    expect(context.value.state).toBe("authenticated");
    expect(context.getPrincipal()?.claims).toEqual({ role: "member" });
    expect(Object.isFrozen(context.getPrincipal())).toBe(true);
    expect(() => context.resolveAnonymous()).toThrow(
      "Authentication context has already been resolved.",
    );
  });

  it("distinguishes pending and resolved anonymous states", () => {
    const context = new AuthenticationContext<Record<string, never>>();

    expect(context.value).toEqual({ state: "pending" });
    context.resolveAnonymous();
    expect(context.value).toEqual({ state: "anonymous" });
    expect(context.getPrincipal()).toBeUndefined();
  });
});

