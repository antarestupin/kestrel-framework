import { describe, expect, it } from "vitest";
import { isRecoverablePostgresPollingError } from "./polling_error.js";

describe("PostgreSQL polling error classification", () => {
  it("recognizes wrapped infrastructure failures and keeps unknown and permanent errors terminal", () => {
    expect(isRecoverablePostgresPollingError(new Error("query failed", { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isRecoverablePostgresPollingError({ code: "40001" })).toBe(true);
    expect(isRecoverablePostgresPollingError({ code: "28P01" })).toBe(false);
    expect(isRecoverablePostgresPollingError({ code: "42P01" })).toBe(false);
    expect(isRecoverablePostgresPollingError(new AggregateError([{ code: "ECONNRESET" }, new Error("invariant")]))).toBe(false);
    const circular: { cause?: unknown } = {}; circular.cause = circular;
    expect(isRecoverablePostgresPollingError(circular)).toBe(false);
  });
});
