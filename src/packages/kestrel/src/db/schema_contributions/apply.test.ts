import { describe, expect, it, vi } from "vitest";

import { defineDatabaseSchemaContribution } from "./definition.js";
import { applyDatabaseSchemaContributions } from "./apply.js";

describe("applyDatabaseSchemaContributions", () => {
  it("applies every contribution in stable identifier order", async () => {
    const second = defineDatabaseSchemaContribution({}, {
      id: "test:second",
      installSql: "SELECT 2;",
    });
    const first = defineDatabaseSchemaContribution({}, {
      id: "test:first",
      installSql: "SELECT 1;",
    });
    const execute = vi.fn(async () => undefined);

    await applyDatabaseSchemaContributions({ second, first }, execute);

    expect(execute.mock.calls).toEqual([
      ["SELECT 1;"],
      ["SELECT 2;"],
    ]);
  });

  it("stops when a contribution cannot be applied", async () => {
    const first = defineDatabaseSchemaContribution({}, {
      id: "test:first",
      installSql: "SELECT 1;",
    });
    const second = defineDatabaseSchemaContribution({}, {
      id: "test:second",
      installSql: "SELECT 2;",
    });
    const execute = vi.fn(async (statement: string) => {
      if (statement === "SELECT 1;") {
        throw new Error("database unavailable");
      }
    });

    await expect(
      applyDatabaseSchemaContributions({ first, second }, execute),
    ).rejects.toThrow("database unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
