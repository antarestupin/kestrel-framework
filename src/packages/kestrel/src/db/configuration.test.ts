import { describe, expect, it } from "vitest";
import { postgresDrizzleConfigBase } from "./configuration.js";

const connection = { host: "localhost", user: "postgres", password: "secret", database: "test" };

describe("PostgreSQL resource configuration", () => {
  it("uses finite native budgets and a separate resource policy", () => {
    expect(postgresDrizzleConfigBase.schema.parse(connection)).toMatchObject({
      max: 10, min: 0, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
      statement_timeout: 30_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 10_000,
      query_timeout: 35_000, options: "-c transaction_timeout=60000",
      resourcePolicy: { maxWaitingRequests: 100, shutdownTimeoutMs: 10_000 },
    });
  });

  it.each([
    { max: 0 }, { min: 11 }, { connectionTimeoutMillis: 0 },
    { statement_timeout: -1 }, { lock_timeout: "no" }, { max: 1.5 },
    { maxLifetimeSeconds: 2_147_484 }, { idleTimeoutMillis: 2 ** 32 }, { resourcePolicy: { shutdownTimeoutMs: 0 } },
    { resourcePolicy: { maxWaitingRequests: -1 } },
  ])("rejects invalid budgets: %j", (override) => {
    expect(() => postgresDrizzleConfigBase.schema.parse({ ...connection, ...override })).toThrow();
  });

  it("accepts environment numbers and preserves advanced native pg and TLS options", () => {
    const getTypeParser = () => (value: string) => value;
    const checkServerIdentity = () => undefined;
    const parsed = postgresDrizzleConfigBase.schema.parse({
      ...connection, max: "20", connectionTimeoutMillis: "400", statement_timeout: 0,
      types: { getTypeParser }, ssl: { ca: "certificate", checkServerIdentity },
      resourcePolicy: { maxWaitingRequests: "0" },
    });
    expect(parsed.max).toBe(20);
    expect(parsed.types).toEqual({ getTypeParser });
    expect(parsed.ssl).toEqual({ ca: "certificate", rejectUnauthorized: true, checkServerIdentity });
    expect(parsed.resourcePolicy.maxWaitingRequests).toBe(0);
  });
});
