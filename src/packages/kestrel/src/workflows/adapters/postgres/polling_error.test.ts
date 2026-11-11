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

  it("retries known connection, transaction and server availability failures", () => {
    for (const code of ["08006", "40001", "40P01", "53300", "57P01", "57P02", "57P03",
      "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]) {
      expect(isRecoverablePostgresPollingError({ code })).toBe(true);
    }
    for (const error of [null, "08006", { code: 8006 }, { code: "23505" }, new AggregateError([])]) {
      expect(isRecoverablePostgresPollingError(error)).toBe(false);
    }
    expect(isRecoverablePostgresPollingError(new AggregateError([
      { code: "08006" }, new Error("wrapped", { cause: { code: "40P01" } }),
    ]))).toBe(true);
  });

  it("treats shared causes as transient and actual cause cycles as terminal", () => {
    const cause = { code: "08006" };
    expect(isRecoverablePostgresPollingError(new AggregateError([
      new Error("first", { cause }), new Error("second", { cause }),
    ]))).toBe(true);

    const cycle = new AggregateError([cause]);
    cycle.errors.push(cycle);
    expect(isRecoverablePostgresPollingError(cycle)).toBe(false);
  });
});
