import { describe, expect, it } from "vitest";

import { throttlingConfigBase } from "./configuration.js";

describe("throttling failure policy configuration", () => {
  it("defaults to rejecting requests when the backend fails", () => {
    expect(throttlingConfigBase.schema.parse({ namespace: "test" }).backendFailurePolicy)
      .toEqual({ strategy: "reject" });
  });

  // Parse explicit strategies: an omitted value can bypass union validation via a default.
  it.each([
    { strategy: "reject" },
    { strategy: "emergency-local", capacity: 5, periodMs: 1_000 },
  ])("preserves an explicitly configured failure policy %j", (backendFailurePolicy) => {
    expect(throttlingConfigBase.schema.parse({ namespace: "test", backendFailurePolicy }).backendFailurePolicy)
      .toEqual(backendFailurePolicy);
  });

  it.each(["", "unsupported"])("rejects an unknown strategy %j", (strategy) => {
    expect(() => throttlingConfigBase.schema.parse({
      namespace: "test", backendFailurePolicy: { strategy },
    })).toThrow();
  });
});
