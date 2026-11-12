import { describe, expect, it } from "vitest";

import {
  ExecutionContext,
  sealExecutionContext,
  type ExecutionContextValue,
} from "./execution_context.js";

describe("ExecutionContext", () => {
  it("retains internal value identity without exporting it", () => {
    class CurrentUser {
      public constructor(public role: string) {}
    }

    const context = new ExecutionContext();
    const user = new CurrentUser("member");

    context.set("currentUser", user);
    user.role = "admin";

    expect(context.entries()).toEqual([{
      key: "currentUser",
      value: user,
      destinations: [],
    }]);
    expect(context.entries()[0]?.value).toBe(user);
    expect(context.get("currentUser")).toBe(user);
    expect(context.toRecord("log")).toEqual({});
  });

  it("copies and freezes diagnostics for both destinations by default", () => {
    const context = new ExecutionContext();
    const details = { role: "member", permissions: ["read"] };

    context.setDiagnostic("subject", details);
    details.role = "admin";
    details.permissions.push("write");

    const logRecord = context.toRecord("log");

    expect(logRecord).toEqual({
      subject: { role: "member", permissions: ["read"] },
    });
    expect(context.toRecord("observation")).toEqual(logRecord);
    expect(Object.isFrozen(logRecord)).toBe(true);
    expect(Object.isFrozen(logRecord.subject)).toBe(true);
    expect(Object.isFrozen(
      (logRecord.subject as { permissions: readonly string[] }).permissions,
    )).toBe(true);
  });

  it("distinguishes replacement from accumulation and combines destinations", () => {
    const context = new ExecutionContext();

    context.setDiagnostic("ids", "replaced", {
      destinations: ["log"],
    });
    context.setDiagnostic("ids", "first", {
      destinations: ["observation"],
    });
    context.appendDiagnostic("ids", "second", {
      destinations: ["log"],
    });

    expect(context.entries()).toEqual([{
      key: "ids",
      value: ["first", "second"],
      destinations: ["observation", "log"],
    }]);
  });

  it("accumulates internal and diagnostic values under normalized keys without mixing policies", () => {
    const context = new ExecutionContext();
    const internal = { id: 1 };
    context.set(" items ", internal);
    context.append("items", 2);
    context.append("items", 3);
    context.appendDiagnostic(" points ", 10, { destinations: ["log"] });
    context.appendDiagnostic("points", 20, { destinations: ["observation", "log"] });

    expect(context.get(" items ")).toEqual([internal, 2, 3]);
    expect((context.get("items") as unknown[])[0]).toBe(internal);
    expect(() => context.append("points", 30)).toThrow("internal value to diagnostic");
    expect(() => context.appendDiagnostic("items", 4)).toThrow("diagnostic value to internal");
    expect(context.toRecord("log")).toEqual({ points: [10, 20] });
    expect(context.toRecord("observation")).toEqual({ points: [10, 20] });
  });

  it("initializes a missing internal accumulator and reads missing keys as undefined", () => {
    const context = new ExecutionContext();
    const value = { private: true };
    expect(context.get("missing")).toBeUndefined();
    context.append("missing", value);
    expect(context.get("missing")).toEqual([value]);
    expect((context.get("missing") as unknown[])[0]).toBe(value);
    expect(context.toRecord("observation")).toEqual({});
  });

  it("copies sparse arrays and records with no prototype into JSON-safe values", () => {
    const context = new ExecutionContext();
    const details = Object.assign(Object.create(null) as { enabled: boolean }, { enabled: false });
    const values = new Array<ExecutionContextValue>(3);
    values[1] = details;

    context.setDiagnostic("details", values);
    details.enabled = true;

    expect(context.toRecord("observation")).toEqual({ details: [null, { enabled: false }, null] });
  });

  it("rejects array accessors and named properties before exporting diagnostics", () => {
    const context = new ExecutionContext();
    const arrayWithAccessor = Object.defineProperty([1], "0", {
      get: () => { throw new Error("The array getter must not run."); },
    });
    const arrayWithNamedProperty = Object.assign([1, 2], { "01": "not an index" });
    const arrayWithNegativeIndex = Object.assign([1], { "-1": "not an index" });
    const arrayWithLabel = Object.assign([1], { label: "not an index" });

    expect(() => context.setDiagnostic("accessor", arrayWithAccessor)).toThrow("accessor properties");
    for (const value of [arrayWithNamedProperty, arrayWithNegativeIndex, arrayWithLabel]) {
      expect(() => context.setDiagnostic("named", value)).toThrow("named properties");
    }
    expect(context.entries()).toEqual([]);
  });

  it("bounds nested values and rejects unknown diagnostic destinations", () => {
    const context = new ExecutionContext();
    let value: ExecutionContextValue = true;
    for (let depth = 0; depth < 101; depth++) value = { child: value };

    expect(() => context.setDiagnostic("deep", value)).toThrow("100 nested levels");
    expect(() => context.setDiagnostic("destination", true, {
      destinations: ["unknown" as "log"],
    })).toThrow('Unknown execution context diagnostic destination "unknown"');
    expect(context.entries()).toEqual([]);
  });

  it("bounds nesting through array elements and copies shared values without treating them as cycles", () => {
    const context = new ExecutionContext();
    let deep: ExecutionContextValue = null;
    for (let level = 0; level < 101; level++) deep = [deep];
    expect(() => context.setDiagnostic("deep", deep)).toThrow("100 nested levels");

    const shared = { note: null };
    context.setDiagnostic("shared", { one: shared, two: [shared] });
    expect(context.toRecord("observation")).toEqual({ shared: { one: shared, two: [shared] } });
  });

  it.each(["maxEntrySizeBytes", "maxTotalSizeBytes"] as const)("identifies the invalid %s setting", (key) => {
    expect(() => new ExecutionContext({ [key]: 0 })).toThrow(`Execution context ${key} must be a positive integer.`);
  });

  it.each([
    ["cyclic objects", () => {
      const value: { self?: unknown } = {};
      value.self = value;

      return value;
    }, "cycles"],
    ["class instances", () => new Date(), "plain objects"],
    ["bigints", () => 1n, "bigint"],
    ["functions", () => () => undefined, "function"],
    ["symbols", () => Symbol("value"), "symbol"],
    ["undefined", () => undefined, "undefined"],
    ["non-finite numbers", () => Number.POSITIVE_INFINITY, "finite numbers"],
  ])("rejects %s at runtime", (_name, createValue, message) => {
    const context = new ExecutionContext();

    expect(() => context.setDiagnostic(
      "invalid",
      createValue() as ExecutionContextValue,
    )).toThrow(message);
    expect(context.entries()).toEqual([]);
  });

  it("rejects active object properties without invoking them", () => {
    const context = new ExecutionContext();
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("The getter must not run.");
      },
    });
    const toJson = { toJSON: () => ({ exposed: true }) };
    const symbolProperty = { safe: true } as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("secret")] = true;

    expect(() => context.setDiagnostic(
      "accessor",
      accessor as ExecutionContextValue,
    )).toThrow("accessor properties");
    expect(() => context.setDiagnostic(
      "toJson",
      toJson as unknown as ExecutionContextValue,
    )).toThrow("function values");
    expect(() => context.setDiagnostic(
      "symbolProperty",
      symbolProperty as ExecutionContextValue,
    )).toThrow("symbol properties");
  });

  it("rejects size-limit violations atomically", () => {
    const entryBoundContext = new ExecutionContext({
      maxEntrySizeBytes: 12,
      maxTotalSizeBytes: 100,
    });

    expect(() => entryBoundContext.setDiagnostic("key", "value"))
      .toThrow("entry limit");
    expect(entryBoundContext.entries()).toEqual([]);

    const totalBoundContext = new ExecutionContext({
      maxEntrySizeBytes: 100,
      maxTotalSizeBytes: 20,
    });

    totalBoundContext.setDiagnostic("first", "a");

    expect(() => totalBoundContext.setDiagnostic("second", "b"))
      .toThrow("total limit");
    expect(totalBoundContext.toRecord("log")).toEqual({ first: "a" });

    const appendBoundContext = new ExecutionContext({
      maxEntrySizeBytes: 20,
      maxTotalSizeBytes: 100,
    });

    appendBoundContext.setDiagnostic("x", "a");

    expect(() => appendBoundContext.appendDiagnostic("x", "1234567890"))
      .toThrow("entry limit");
    expect(appendBoundContext.toRecord("log")).toEqual({ x: "a" });
  });

  it("counts UTF-8 bytes and releases replaced diagnostic budget", () => {
    const unicodeContext = new ExecutionContext({
      maxEntrySizeBytes: 9,
      maxTotalSizeBytes: 100,
    });

    expect(() => unicodeContext.setDiagnostic("x", "é"))
      .toThrow("10 bytes");

    const replacementContext = new ExecutionContext({
      maxEntrySizeBytes: 100,
      maxTotalSizeBytes: 30,
    });

    replacementContext.setDiagnostic("first", "12345");
    expect(() => replacementContext.setDiagnostic("second", "b"))
      .toThrow("total limit");

    replacementContext.setDiagnostic("first", "a");
    replacementContext.setDiagnostic("second", "b");

    expect(replacementContext.toRecord("log")).toEqual({
      first: "a",
      second: "b",
    });
  });

  it("validates keys, destinations, limits and completion writes", () => {
    expect(() => new ExecutionContext({ maxEntrySizeBytes: 0 }))
      .toThrow("positive integer");

    const context = new ExecutionContext();

    expect(() => context.set(" ", true)).toThrow("key cannot be empty");
    expect(() => context.setDiagnostic("valid", true, {
      destinations: [],
    })).toThrow("at least one destination");

    context.set("valid", true);
    sealExecutionContext(context);

    expect(() => context.set("late", true))
      .toThrow("Cannot modify a completed execution context");
    expect(() => context.append("valid", false))
      .toThrow("Cannot modify a completed execution context");
    expect(() => context.setDiagnostic("late", true))
      .toThrow("Cannot modify a completed execution context");
    expect(() => context.appendDiagnostic("valid", false))
      .toThrow("Cannot modify a completed execution context");
  });
});
