import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresEmailCaptureStorageAdapter } from "./capture_store.js";

describe("PostgresEmailCaptureStorageAdapter", () => {
  it("verifies tables and prunes captures through a bounded retention policy", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PostgresEmailCaptureStorageAdapter({ query } as unknown as Pool);

    await store.prepare(7);

    expect(query).toHaveBeenNthCalledWith(
      1,
      "select 1 from dev.email_capture limit 1",
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `with expired as materialized (
        select id from dev.email_capture
        where captured_at < now() - ($1 * interval '1 day')
      ), deleted_attachments as (
        delete from dev.email_capture_attachment
        where capture_id in (select id from expired)
      )
      delete from dev.email_capture
      where id in (select id from expired)`,
      [7],
    );
  });

  it("rejects an invalid retention boundary", async () => {
    const store = new PostgresEmailCaptureStorageAdapter({} as Pool);

    await expect(store.prepare(0)).rejects.toThrow("positive integer");
  });
});
