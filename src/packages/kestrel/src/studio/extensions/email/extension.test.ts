import Fastify, { type FastifyInstance } from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../../../app/index.js";
import {
  EmailCaptureInbox,
  MemoryEmailCaptureStorageAdapter,
  type EmailCaptureInboxSource,
} from "../../../email/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import type { DevObservationSource } from "../../../observability/index.js";
import { Studio } from "../../studio.js";
import { defineDevEmailExtension } from "./extension.js";

const captureId = "00000000-0000-4000-8000-000000000010";
const replayCaptureId = "00000000-0000-4000-8000-000000000011";
const observationId = "00000000-0000-4000-8000-000000000020";

describe("development email Studio extension", () => {
  it("exposes correlated history and safe capture details", async () => {
    const source = await createCaptureSource();
    const observations = createObservationSource();
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevEmailExtension(source, observations)],
    });
    const app = await registerStudioControllers(studio, server);
    expect(studio.getManifest().extensions[0]).toMatchObject({
      title: "Development email", description: "Inspect transactional emails captured by the local application.",
      pages: [
        { title: "Email history", description: "Timing and normalized outcomes for transactional sends." },
        { title: "Email inbox", description: "Messages captured locally without contacting recipients." },
        { title: "Captured email", description: "Safe preview and diagnostics for one captured message.", showInNavigation: false },
      ],
    });
    const controllers = await studio.defineHttpControllers();
    expect(controllers.slice(1).map(({ description }) => description)).toEqual([
      "List transactional email send observations.", "List locally captured emails.", "Clear the local email capture inbox.",
      "Read one captured email and its send observation.", "Replay one captured email through the configured local transport.",
    ]);

    const history = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-email/history?before=12&limit=10",
    });
    const inbox = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-email/captures",
    });
    const detail = await server.inject({
      method: "GET",
      url: `/_studio/api/extensions/development-email/captures/${captureId}`,
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({
      items: [{
        sequence: 11,
        id: observationId,
        executionId: "execution-1",
        occurredAt: "2026-08-24T10:00:00.000Z",
        outcome: "success",
        durationMs: 12.5,
        client: "application",
        operation: "account.welcome",
        transport: "local-capture",
        result: "accepted",
        recipientCount: 1,
        attachmentCount: 1,
        captureId,
      }],
      nextBefore: null,
    });
    expect(observations.listObservations).toHaveBeenCalledWith({
      before: 12,
      limit: 10,
      name: "email.send",
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toMatchObject({
      items: [{ id: captureId, observationId, hasText: true, hasHtml: true, attachmentCount: 1, attachmentBytes: 19 }],
    });
    expect(JSON.stringify(inbox.json())).not.toContain("attachment contents");
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: captureId,
      observationId,
      headers: {
        "X-Debug-Label": "welcome",
        Authorization: "[REDACTED]",
      },
      attachments: [{
        filename: "private.txt",
        contentType: "text/plain",
        size: 19,
      }],
      observation: {
        id: observationId,
        executionId: "execution-1",
        operation: "account.welcome",
      },
    });
    expect(JSON.stringify(detail.json())).not.toContain("attachment contents");
    expect(observations.getObservation).toHaveBeenCalledWith(observationId);

    await server.close();
    await app.dispose();
  });

  it("replays through the inbox source and returns the new correlation target", async () => {
    const source = await createCaptureSource();
    const resend = vi.spyOn(source, "resend").mockResolvedValue({
      receipt: {
        status: "accepted",
        captureId: replayCaptureId,
        messageId: replayCaptureId,
      },
    });
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevEmailExtension(source, createObservationSource())],
    });
    const app = await registerStudioControllers(studio, server);

    const response = await server.inject({
      method: "POST",
      url: `/_studio/api/extensions/development-email/captures/${captureId}/resend`,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      captureId: replayCaptureId,
      messageId: replayCaptureId,
    });
    expect(resend).toHaveBeenCalledWith(captureId);

    await server.close();
    await app.dispose();
  });

  it("returns not found for an expired capture", async () => {
    const source = await createCaptureSource();
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevEmailExtension(source, createObservationSource())],
    });
    const app = await registerStudioControllers(studio, server);

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-email/captures/00000000-0000-4000-8000-000000000099",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "The captured email does not exist or has expired.",
    });

    await server.close();
    await app.dispose();
  });

  it("handles missing correlation and optional metadata in the local inbox", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    await store.capture({
      id: captureId, observationId, capturedAt: new Date("2026-08-24T10:00:00.000Z"),
      message: {
        from: { address: "sender@example.test" },
        to: [{ address: "recipient@example.test", name: "Example recipient" }],
        cc: [], bcc: [], replyTo: [], subject: "Minimal", text: "Only text",
        attachments: [
          { filename: "message.txt", content: "private content", disposition: "inline", contentId: "item" },
          { filename: "unicode.txt", content: "é" },
        ],
      },
    });
    await store.capture({
      id: replayCaptureId, observationId, capturedAt: new Date("2026-08-24T10:00:01.000Z"),
      message: {
        from: { address: "sender@example.test" }, to: [{ address: "recipient@example.test" }],
        cc: [], bcc: [], replyTo: [], subject: "HTML only", html: "<p>Hello</p>", attachments: [],
      },
    });
    const source = new EmailCaptureInbox(store, async () => ({ status: "accepted" }));
    const list = vi.spyOn(source, "list");
    const observations = createObservationSource();
    observations.getObservation.mockResolvedValue(undefined);
    const [record] = (await observations.listObservations({ name: "email.send" })).items;
    observations.listObservations.mockClear();
    observations.listObservations.mockResolvedValueOnce({
      items: [{ ...record!, data: { client: 14, recipientCount: "1", attachmentCount: Infinity } }],
      nextBefore: 11,
    });
    const server = Fastify();
    const app = await registerStudioControllers(
      new Studio({ extensions: [defineDevEmailExtension(source, observations)] }), server,
    );
    const prefix = "/_studio/api/extensions/development-email";

    try {
      const history = await server.inject({ url: `${prefix}/history` });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({
        items: [{ client: null, operation: null, recipientCount: null, attachmentCount: null }], nextBefore: 11,
      });
      expect(observations.listObservations.mock.calls).toStrictEqual([[{ name: "email.send" }]]);
      const page = await server.inject({ url: `${prefix}/captures?before=12&limit=1` });
      expect(page.statusCode).toBe(200);
      expect((await server.inject({ url: `${prefix}/captures` })).statusCode).toBe(200);
      expect(list.mock.calls).toStrictEqual([[{ before: 12, limit: 1 }], [{}]]);
      const detail = await server.inject({ url: `${prefix}/captures/${captureId}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        text: "Only text", html: null, headers: {}, observation: null,
        hasText: true, hasHtml: false, attachmentCount: 2, attachmentBytes: 17,
        from: { name: null }, to: [{ name: "Example recipient" }],
        attachments: [
          { contentType: null, disposition: "inline", contentId: "item", size: 15 },
          { filename: "unicode.txt", contentType: null, disposition: null, contentId: null, size: 2 },
        ],
      });
      expect(detail.body).not.toContain("private content");
      const htmlOnly = await server.inject({ url: `${prefix}/captures/${replayCaptureId}` });
      expect(htmlOnly.statusCode).toBe(200);
      expect(htmlOnly.json()).toMatchObject({ text: null, html: "<p>Hello</p>", hasText: false, hasHtml: true });
      const resend = await server.inject({ method: "POST", url: `${prefix}/captures/${captureId}/resend` });
      expect(resend.statusCode).toBe(201);
      expect(resend.json()).toEqual({ captureId: null, messageId: null });
      expect((await server.inject({ method: "DELETE", url: `${prefix}/captures` })).statusCode).toBe(204);
      const missing = await server.inject({ method: "POST", url: `${prefix}/captures/${captureId}/resend` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        statusCode: 404, error: "Not Found", message: "The captured email does not exist or has expired.",
      });
      vi.spyOn(source, "resend").mockRejectedValueOnce(new Error("temporary SMTP outage"));
      expect((await server.inject({ method: "POST", url: `${prefix}/captures/${captureId}/resend` })).statusCode).toBe(500);
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});

async function createCaptureSource(): Promise<EmailCaptureInboxSource> {
  const store = new MemoryEmailCaptureStorageAdapter();
  await store.capture({
    id: captureId,
    observationId,
    capturedAt: new Date("2026-08-24T10:00:00.000Z"),
    message: {
      from: { address: "sender@example.test", name: "Example App" },
      to: [{ address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Welcome",
      text: "Hello",
      html: "<h1>Hello</h1>",
      headers: {
        Authorization: "Bearer private-token",
        "X-Debug-Label": "welcome",
      },
      attachments: [{
        filename: "private.txt",
        content: "attachment contents",
        contentType: "text/plain",
      }],
    },
  });

  return new EmailCaptureInbox(store, async () => ({ status: "accepted" }));
}

function createObservationSource(): DevObservationSource & {
  getObservation: ReturnType<typeof vi.fn<DevObservationSource["getObservation"]>>;
  listObservations: ReturnType<typeof vi.fn<DevObservationSource["listObservations"]>>;
} {
  const observation = {
    sequence: 11,
    id: observationId,
    executionId: "execution-1",
    occurredAt: new Date("2026-08-24T10:00:00.000Z"),
    name: "email.send",
    category: "email",
    schemaVersion: 1,
    outcome: "success" as const,
    durationMs: 12.5,
    data: {
      client: "application",
      operation: "account.welcome",
      transport: "local-capture",
      result: "accepted",
      recipientCount: 1,
      attachmentCount: 1,
      captureId,
    },
    createdAt: new Date("2026-08-24T10:00:00.001Z"),
  };

  return {
    clear: vi.fn(async () => undefined),
    getObservation: vi.fn(async (id) => id === observationId
      ? observation
      : undefined),
    listEvents: vi.fn(async () => []),
    listEventsByContext: vi.fn(async () => []),
    listObservations: vi.fn(async () => ({
      items: [observation],
      nextBefore: null,
    })),
    listExecutions: vi.fn(async () => ({ items: [], nextBefore: null })),
  };
}

async function registerStudioControllers(
  studio: Studio,
  server: FastifyInstance,
): Promise<App<Record<string, never>>> {
  const app = new App({});
  const manager = new HttpControllerManager(app, server);

  for (const controller of await studio.defineHttpControllers()) {
    manager.register(controller);
  }
  await app.start();

  return app;
}
