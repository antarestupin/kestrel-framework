import type { Pool } from "pg";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PostgresObservationStore } from "./observation_store.js";

describe("PostgresObservationStore", () => {
  it("loads complete timelines for executions matching a diagnostic context", async () => {
    const query = vi.fn(async (..._arguments: unknown[]) => ({ rows: [] }));
    const store = new PostgresObservationStore({
      query,
    } as unknown as Pool);

    await store.listEventsByContext("workflow.executionId", "workflow-1");

    expect(query).toHaveBeenCalledOnce();
    const [statement] = query.mock.calls[0] as [string | { text: string }];
    const sql = typeof statement === "string" ? statement : statement?.text;

    expect(sql).toContain(
      `"dev"."observation"."execution_id" in (select "execution_id" from "dev"."observation" where "dev"."observation"."data"->'context'->>$1 = $2)`,
    );
  });
});
