import { expect, it } from "vitest";
import { createApplicationNames } from "./application_names.mjs";

it("reserves the PostgreSQL test suffix without shortening names at the boundary", () => {
  const names = createApplicationNames("a".repeat(58));
  expect(names.databaseName).toBe("a".repeat(58));
  expect(names.testDatabaseName).toHaveLength(63);
});

it("keeps long database names deterministic and distinguishes a shared truncated prefix", () => {
  const prefix = "a".repeat(100);
  const first = createApplicationNames(`${prefix}-first`);
  const second = createApplicationNames(`${prefix}-second`);
  expect(first).toEqual(createApplicationNames(`${prefix}-first`));
  expect(first.databaseName).not.toBe(second.databaseName);
  expect(first.databaseName).toHaveLength(58);
  expect(second.testDatabaseName).toHaveLength(63);
  expect(createApplicationNames("a".repeat(214)).applicationName).toHaveLength(214);
});
