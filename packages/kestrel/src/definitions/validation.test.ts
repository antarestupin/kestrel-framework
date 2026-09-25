import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseSchema, resolveValidation, safeParseSchema } from "./index.js";

describe("definition validation", () => {
  it("defaults omitted boundaries to sync and snapshots caller options", () => {
    expect(resolveValidation()).toEqual({ input: "sync", output: "sync" });
    const options = { input: "async" as const };
    const resolved = resolveValidation(options);
    expect(resolved).toEqual({ input: "async", output: "sync" });
    expect(resolved).not.toBe(options);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("preserves compiled parsing, transformations and detailed failures", async () => {
    // Compile locally so this test does not mutate Zod's global configuration.
    const schema = z.object({
      name: z.string().trim().min(1),
      count: z.coerce.number().int().default(1),
    });
    const compiled = z.compile(schema);
    expect(parseSchema(compiled, { name: " value ", extra: true }))
      .toEqual({ name: "value", count: 1 });
    const invalid = { name: "", count: "invalid" };
    const result = await safeParseSchema(compiled, invalid);
    const expected = schema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success && !expected.success) {
      expect(result.error.issues).toEqual(expected.error.issues);
    }
  });

  it("rejects undeclared async callbacks without retrying them", () => {
    const refine = vi.fn(async () => true);
    const schema = z.string().refine(refine);
    expect(() => parseSchema(schema, "value")).toThrow(/Promise/);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(() => safeParseSchema(schema, "value")).toThrow(/Promise/);
    expect(refine).toHaveBeenCalledTimes(2);
  });

  it("awaits explicit async transforms and preserves safe parse errors", async () => {
    const schema = z.string().transform(async (value) => value.length);
    await expect(parseSchema(schema, "value", "async")).resolves.toBe(5);
    await expect(safeParseSchema(schema, 123, "async"))
      .resolves.toMatchObject({ success: false, error: { issues: [{ code: "invalid_type" }] } });
  });
});
