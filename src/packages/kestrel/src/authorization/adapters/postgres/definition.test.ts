import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it, vi } from "vitest";

import { App } from "../../../app/index.js";
import { PostgresDrizzleManager } from "../../../db/index.js";
import { dep, registerScopedAdapter } from "../../../di/index.js";
import { subjectRoleStoreDependency } from "../../dependencies.js";
import { postgresSubjectRoles } from "./definition.js";

it("uses the default table and resolves a distinct borrowed manager in each execution", async () => {
  // Keep real Drizzle SQL compilation and substitute only its driver transport.
  const query = vi.fn().mockResolvedValueOnce({ rows: [["editor"]] })
    .mockResolvedValueOnce({ rows: [["reviewer"]] });
  const database = drizzle({ client: { query } as never });
  const createManager = vi.fn(() => new PostgresDrizzleManager({ database }));
  const manager = dep<PostgresDrizzleManager>("authorizationDatabaseManager");
  const app = new App({});
  app.container.registerFactory(manager.id, createManager, { lifetime: "scoped" });
  registerScopedAdapter(app.container, subjectRoleStoreDependency.id, postgresSubjectRoles(manager), undefined);

  try {
    await app.start();
    expect(createManager).not.toHaveBeenCalled();
    for (const [subject, role] of [["subject-1", "editor"], ["subject-2", "reviewer"]] as const) {
      const execution = await app.createExecutionScope();
      try {
        const store = execution.container.resolve(subjectRoleStoreDependency);
        expect(execution.container.resolve(subjectRoleStoreDependency)).toBe(store);
        await expect(store.listRoleKeys(subject)).resolves.toEqual(new Set([role]));
      } finally {
        await execution.dispose();
      }
    }
    expect(createManager).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([statement, parameters]) => [statement.text, parameters])).toEqual([
      [expect.stringContaining('from "authorization"."subject_role"'), ["subject-1"]],
      [expect.stringContaining('from "authorization"."subject_role"'), ["subject-2"]],
    ]);
  } finally {
    await app.dispose();
  }
});
