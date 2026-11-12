import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createDependencyContainer, dep } from "../../../di/index.js";
import { normalizeEmailMessage } from "../../message.js";
import { postgresEmailCapture } from "./definition.js";
import { PostgresEmailCaptureStorageAdapter } from "./capture_store.js";
import { postgresEmailCaptureConfigBase } from "./configuration.js";

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

  it.each([0, -1, 1.5])("rejects an invalid retention boundary %s", async (retentionDays) => {
    const store = new PostgresEmailCaptureStorageAdapter({} as Pool);

    await expect(store.prepare(retentionDays)).rejects.toThrow("Email capture retentionDays must be a positive integer.");
  });
});

const capturedAt = new Date("2026-01-01T00:00:00.000Z");
const id = "00000000-0000-4000-8000-000000000001";
const observationId = "00000000-0000-4000-8000-000000000002";
const minimalMessage = {
  from: "sender@example.test", to: "reader@example.test", subject: "Welcome", text: "Hello",
};

function fixture() {
  const query = vi.fn(async (_query: string | { text: string }, _values?: readonly unknown[]): Promise<{ rows: unknown[][] }> => ({ rows: [] }));
  const pool = { query } as unknown as Pool;
  const store = new PostgresEmailCaptureStorageAdapter(pool);
  const statement = (call: number) => {
    const input = query.mock.calls[call]?.[0];
    return typeof input === "string" ? input : input?.text;
  };
  return { pool, query, statement, store };
}

/** Driver rows carry the metadata and sensitive fields selected by Drizzle in positional order. */
function captureRow(sequence: number, rich: boolean, textOnly = false) {
  const timestamp = capturedAt.toISOString();
  return [String(sequence), id, observationId, timestamp, { address: "sender@example.test" },
    [{ address: "reader@example.test" }], rich ? [{ address: "copy@example.test" }] : [],
    rich ? [{ address: "audit@example.test" }] : [], [{ address: "reply@example.test" }], "Welcome", rich || textOnly ? "Hello" : null,
    textOnly ? null : rich ? "<p>Hello</p>" : "<p>HTML only</p>", rich ? { "X-Label": "private" } : null,
    rich ? 2 : 0, rich ? "4" : "0", timestamp];
}

const attachments = [
  { filename: "note.txt", content: "é" },
  { filename: "image.png", content: new Uint8Array([0, 255]), contentType: "image/png", disposition: "inline" as const, contentId: "logo" },
];

describe("PostgreSQL email capture persistence", () => {
  it("stores bodies, headers and byte-accurate ordered attachments in one transaction", async () => {
    const { query, statement, store } = fixture();
    await store.capture({ id, observationId, capturedAt, message: normalizeEmailMessage({
      ...minimalMessage, html: "<p>Hello</p>", headers: { "X-Label": "private" }, attachments,
    }) });

    expect(statement(0)).toBe("begin");
    expect(statement(1)).toContain('insert into "dev"."email_capture"');
    expect(query.mock.calls[1]?.[1]).toEqual([
      id, observationId, capturedAt.toISOString(), '{"address":"sender@example.test"}',
      '[{"address":"reader@example.test"}]', "[]", "[]", "[]", "Welcome", "Hello", "<p>Hello</p>", '{"X-Label":"private"}', 2, 4,
    ]);
    expect(statement(2)).toContain('insert into "dev"."email_capture_attachment"');
    expect(query.mock.calls[2]?.[1]).toEqual([
      id, 0, "note.txt", Buffer.from("é"), "text",
      id, 1, "image.png", Buffer.from([0, 255]), "binary", "image/png", "inline", "logo",
    ]);
    expect(statement(3)).toBe("commit");
  });

  it("skips attachment writes for body-only messages and rolls back a failed capture", async () => {
    const { query, statement, store } = fixture();
    await store.capture({ id, observationId, capturedAt, message: normalizeEmailMessage(minimalMessage) });
    expect(statement(1)).toContain('insert into "dev"."email_capture"');
    expect(statement(2)).toBe("commit");
    expect(query).toHaveBeenCalledTimes(3);
    query.mockClear();
    const failure = new Error("attachment constraint rejected the insert");
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
    await expect(store.capture({ id, observationId, capturedAt, message: normalizeEmailMessage({
      from: minimalMessage.from, to: minimalMessage.to, subject: minimalMessage.subject, html: "<p>Hello</p>", attachments,
    }) })).rejects.toMatchObject({ cause: failure });
    expect(statement(3)).toBe("rollback");
  });

  it("loads one message with its text and binary attachments and omits absent optional fields", async () => {
    const { query, statement, store } = fixture();
    const empty = { rows: [] };
    query.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    await expect(store.get(id)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
    expect(statement(2)).toBe("commit");

    query.mockResolvedValueOnce(empty).mockResolvedValueOnce({ rows: [captureRow(3, true)] });
    query.mockResolvedValueOnce({ rows: [
      [id, 0, "note.txt", Buffer.from("é"), "text", null, null, null],
      [id, 1, "image.png", Buffer.from([0, 255]), "binary", "image/png", "inline", "logo"],
    ] });
    await expect(store.get(id)).resolves.toEqual({
      id, observationId, sequence: 3, capturedAt,
      message: normalizeEmailMessage({
        ...minimalMessage, cc: "copy@example.test", bcc: "audit@example.test", replyTo: "reply@example.test",
        html: "<p>Hello</p>", headers: { "X-Label": "private" }, attachments,
      }),
    });
    expect(statement(5)).toContain('order by "dev"."email_capture_attachment"."position" asc');
    query.mockResolvedValueOnce(empty).mockResolvedValueOnce({ rows: [captureRow(2, false)] });
    const html = await store.get(id);
    expect(html?.message).not.toHaveProperty("text");
    expect(html?.message).not.toHaveProperty("headers");
    expect(html?.message.html).toBe("<p>HTML only</p>");
    query.mockResolvedValueOnce(empty).mockResolvedValueOnce({ rows: [captureRow(1, false, true)] });
    const text = await store.get(id);
    expect(text?.message).not.toHaveProperty("html");
    expect(text?.message.text).toBe("Hello");
  });

  it("pages without sensitive message data", async () => {
    const { query, statement, store } = fixture();
    query.mockResolvedValueOnce({ rows: [captureRow(3, true), captureRow(2, false)] });
    const page = await store.list({ before: 4, limit: 0 });
    expect(query.mock.calls[0]?.[1]).toEqual([4, 2]);
    expect(page).toEqual({
      items: [{ id, observationId, sequence: 3, capturedAt, from: { address: "sender@example.test" },
        to: [{ address: "reader@example.test" }], cc: [{ address: "copy@example.test" }], bcc: [{ address: "audit@example.test" }],
        subject: "Welcome", hasText: true, hasHtml: true, attachmentCount: 2, attachmentBytes: 4 }],
      nextBefore: 3,
    });
    await expect(store.list()).resolves.toEqual({ items: [], nextBefore: null });
    expect(query.mock.calls[1]?.[1]).toEqual([51]);
    await expect(store.list({ limit: 101 })).resolves.toEqual({ items: [], nextBefore: null });
    expect(query.mock.calls[2]?.[1]).toEqual([101]);
    query.mockResolvedValueOnce({ rows: [captureRow(2, false)] });
    await expect(store.list({ limit: 1 })).resolves.toMatchObject({
      items: [{ hasText: false, hasHtml: true, attachmentCount: 0, attachmentBytes: 0 }], nextBefore: null,
    });
    query.mockResolvedValueOnce({ rows: [captureRow(1, false, true)] });
    await expect(store.list({ limit: 1 })).resolves.toMatchObject({
      items: [{ hasText: true, hasHtml: false, attachmentCount: 0, attachmentBytes: 0 }], nextBefore: null,
    });
  });

  it("clears attachments and captures using one PostgreSQL statement snapshot", async () => {
    const { query, statement, store } = fixture();

    await store.clear();
    // Two read-committed DELETEs can see different sets of concurrently committed captures.
    expect(query).toHaveBeenCalledOnce();
    expect(statement(0)).toMatch(/with deleted_attachments as \(\s*delete from dev\.email_capture_attachment\s*\)\s*delete from dev\.email_capture/u);
  });

  it("keeps captured attachments visible if clear commits between the two lookup reads", async () => {
    const { query, store } = fixture();
    let repeatableSnapshot = false;
    let cleared = false;
    query.mockImplementation(async (statement) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      if (sql === "begin isolation level repeatable read read only") repeatableSnapshot = true;
      if (sql.includes('from "dev"."email_capture"')) {
        // The concurrent clear becomes visible after the first SELECT in read committed mode.
        cleared = true;
        return { rows: [captureRow(3, true)] };
      }
      if (sql.includes('from "dev"."email_capture_attachment"') && (repeatableSnapshot || !cleared)) {
        return { rows: [
          [id, 0, "note.txt", Buffer.from("é"), "text", null, null, null],
          [id, 1, "image.png", Buffer.from([0, 255]), "binary", "image/png", "inline", "logo"],
        ] };
      }
      return { rows: [] };
    });

    const found = await store.get(id);
    expect(found?.message.attachments).toEqual(attachments);
  });

  it("reads legacy captures that stored a disposition outside the transport contract", async () => {
    const { query, store } = fixture();
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [captureRow(3, true)] })
      .mockResolvedValueOnce({ rows: [
        [id, 0, "note.txt", Buffer.from("é"), "text", null, "legacy", null],
        [id, 1, "regular.txt", Buffer.from("body"), "text", null, "attachment", null],
      ] });

    expect((await store.get(id))?.message.attachments).toStrictEqual([
      { filename: "note.txt", content: "é" },
      { filename: "regular.txt", content: "body", disposition: "attachment" },
    ]);
  });

  it.each([undefined, { code: "42P01" }, { code: "08006" }, null, "failed"])("only ignores missing development tables during initialization (%j)", async (failure) => {
    const { pool, query } = fixture();
    const connection = dep<{ readonly pool: Pool }>("database");
    const container = createDependencyContainer({});
    container.registerValue(connection.id, { pool });
    const definition = postgresEmailCapture(connection, { retentionDays: 5 });
    const store = definition.create(container.resolve.bind(container), undefined);
    if (failure !== undefined) query.mockRejectedValueOnce(failure);
    try {
      if (failure === undefined || (failure !== null && typeof failure === "object" && failure.code === "42P01")) {
        await expect(definition.initialize?.(store)).resolves.toBeUndefined();
      } else {
        await expect(definition.initialize?.(store)).rejects.toBe(failure);
      }
    } finally {
      await container.dispose();
    }
  });
});

it("uses seven days of retention by default and coerces explicit environment values", async () => {
  expect(postgresEmailCaptureConfigBase.schema.parse({})).toEqual({ retentionDays: 7 });
  expect(postgresEmailCaptureConfigBase.schema.parse({ retentionDays: "5" })).toEqual({ retentionDays: 5 });
  for (const retentionDays of [0, -1, "1.5", "invalid"]) {
    expect(postgresEmailCaptureConfigBase.schema.safeParse({ retentionDays }).success).toBe(false);
  }
  const { pool, query } = fixture();
  const connection = dep<{ readonly pool: Pool }>("database");
  const container = createDependencyContainer({});
  container.registerValue(connection.id, { pool });
  try {
    const definition = postgresEmailCapture(connection);
    const store = definition.create(container.resolve.bind(container), undefined);
    await definition.initialize?.(store);
    expect(query.mock.calls[1]?.[1]).toEqual([7]);
  } finally {
    await container.dispose();
  }
});
