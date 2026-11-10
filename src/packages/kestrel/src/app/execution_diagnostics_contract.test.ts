import { describe, expect, it } from "vitest";

import {
  ExecutionContext,
  type ExecutionContextDiagnosticDestination,
} from "./execution_context.js";

describe("ExecutionContext diagnostic budgets", () => {
  it("accepts the exact UTF-8 entry boundary and refuses one extra byte atomically", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 10, maxTotalSizeBytes: 100 });
    // The complete JSON member {"x":"é"} uses ten UTF-8 bytes; adding ASCII 'a' adds one.
    context.setDiagnostic("x", "é", { destinations: ["log"] });
    const before = context.entries();
    expect(context.toRecord("log")).toEqual({ x: "é" });
    expect(() => context.setDiagnostic("x", "aé", { destinations: ["observation"] })).toThrow(RangeError);
    expect(context.entries()).toEqual(before);
    expect(context.toRecord("observation")).toEqual({});
  });

  it("counts UTF-8 key bytes as part of the complete diagnostic member", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 10, maxTotalSizeBytes: 100 });
    // Replacing one ASCII key byte with a two-byte letter must consume another byte.
    context.setDiagnostic("é", "x");
    expect(context.toRecord("log")).toEqual({ é: "x" });
    expect(() => context.setDiagnostic("aé", "x")).toThrow(RangeError);
    expect(context.toRecord("log")).toEqual({ é: "x" });
  });

  it("accepts the exact aggregate boundary and preserves both entries after a one-byte overflow", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 100, maxTotalSizeBytes: 20 });
    context.setDiagnostic("x", "é", { destinations: ["log"] });
    context.setDiagnostic("y", "é", { destinations: ["observation"] });
    const before = context.entries();
    expect(() => context.setDiagnostic("y", "aé", { destinations: ["log"] })).toThrow(RangeError);
    expect(context.entries()).toEqual(before);
    expect(context.toRecord("log")).toEqual({ x: "é" });
    expect(context.toRecord("observation")).toEqual({ y: "é" });
    // A rejected replacement must not reserve bytes that prevent a later equal-sized replacement.
    context.setDiagnostic("y", "b", { destinations: ["observation"] });
    context.setDiagnostic("y", "é", { destinations: ["observation"] });
    expect(context.entries()).toEqual(before);
  });

  it("charges append as the complete accumulated value and replaces without retaining old budget", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 16, maxTotalSizeBytes: 16 });
    context.setDiagnostic("x", "é", { destinations: ["log"] });
    // {"x":["é","a"]} has sixteen bytes and reaches both limits exactly.
    context.appendDiagnostic("x", "a", { destinations: ["observation"] });
    const before = context.entries();
    expect(context.get("x")).toEqual(["é", "a"]);
    expect(context.entries()[0]?.destinations).toEqual(["log", "observation"]);
    expect(() => context.appendDiagnostic("x", "b")).toThrow(RangeError);
    expect(context.entries()).toEqual(before);
    context.setDiagnostic("x", "é");
    expect(context.get("x")).toBe("é");
    context.appendDiagnostic("x", "a");
    expect(context.get("x")).toEqual(["é", "a"]);
  });

  it("releases diagnostic budget when replacing a value with internal state", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 10, maxTotalSizeBytes: 10 });
    context.setDiagnostic("x", "é");
    const internal = { mutable: true };
    context.set("x", internal);
    expect(context.get("x")).toBe(internal);
    expect(context.toRecord("log")).toEqual({});
    context.setDiagnostic("y", "é");
    expect(context.toRecord("log")).toEqual({ y: "é" });
    internal.mutable = false;
    expect(context.get("x")).toBe(internal);
  });

  it("preserves internal identity when a diagnostic replacement exceeds its budget", () => {
    const context = new ExecutionContext({ maxEntrySizeBytes: 10, maxTotalSizeBytes: 10 });
    const internal = { private: true };
    context.set("x", internal);
    expect(() => context.setDiagnostic("x", "aé")).toThrow(RangeError);
    expect(context.get("x")).toBe(internal);
    expect(context.toRecord("log")).toEqual({});
    context.setDiagnostic("y", "é");
    expect(context.toRecord("log")).toEqual({ y: "é" });
  });

  for (const operation of ["set", "append"] as const) {
    it(`rejects an unknown destination during ${operation} without changing entries or charging budget`, () => {
      const context = new ExecutionContext({ maxEntrySizeBytes: 100, maxTotalSizeBytes: 20 });
      context.setDiagnostic("x", "é", { destinations: ["log"] });
      const before = context.entries();
      // JavaScript integrations can supply a runtime value outside the TypeScript destination union.
      const invalid = ["observation", "audit"] as unknown as readonly ExecutionContextDiagnosticDestination[];
      expect(() => operation === "set"
        ? context.setDiagnostic("y", "é", { destinations: invalid })
        : context.appendDiagnostic("x", "a", { destinations: invalid })).toThrow(TypeError);
      expect(context.entries()).toEqual(before);
      expect(context.toRecord("observation")).toEqual({});
      context.setDiagnostic("y", "é", { destinations: ["observation", "observation"] });
      expect(context.entries()).toEqual([
        { key: "x", value: "é", destinations: ["log"] },
        { key: "y", value: "é", destinations: ["observation"] },
      ]);
    });
  }
});
