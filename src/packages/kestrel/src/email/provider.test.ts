import { dep } from "../di/index.js";
import { MemoryEmailCaptureStorageAdapter, defineEmailCaptureStorageAdapter } from "./index.js";
import {
  memoryEmail,
  memoryEmailCapture,
  captureEmail,
  defineEmailTransportAdapter,
} from "./index.js";
import { describe, expect, it, vi } from "vitest";

import { App, type ProviderCompositionApp } from "../app/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import { emailConfigBase, type EmailConfig } from "./configuration.js";
import { emailCaptureInboxDependency, emailClientDependency } from "./dependencies.js";
import { EmailProvider } from "./provider.js";
import type { EmailTransportAdapter } from "./types.js";

describe("EmailProvider", () => {
  it("records through the observer active for the execution", async () => {
    const observerContext = new AsyncLocalObserverContext();
    const observer = { record: vi.fn() } as unknown as Observer;
    const app = new App({ name: "test" });

    app.container.registerValue("observerContext", observerContext);
    app.register(
      new EmailProvider(
        emailConfig({
          enabled: true,
          name: "transactional",
        }),
        memoryEmail(),
      ),
    );

    const client = app.container.resolve(emailClientDependency);
    await observerContext.run(observer, () =>
      client.send(
        {
          from: "sender@example.com",
          to: "member@example.com",
          subject: "Welcome",
          text: "Hello",
        },
        { operation: "member.welcome" },
      ),
    );

    expect(observer.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "email.send" }),
      {
        client: "transactional",
        operation: "member.welcome",
        transport: "memory",
        result: "accepted",
        recipientCount: 1,
        attachmentCount: 0,
      },
      expect.objectContaining({ outcome: "success" }),
    );
    await app.dispose();
  });

  it("registers a capture-backed client and inbox from configuration", async () => {
    const app = new App({ name: "test" }).register(
      new EmailProvider(
        emailConfig({
          enabled: true,
        }),
        captureEmail(memoryEmailCapture(), { maxMessageBytes: 1024 }),
      ),
    );
    const client = app.container.resolve(emailClientDependency);

    const receipt = await client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    });
    const inbox = app.container.resolve(emailCaptureInboxDependency);

    expect(receipt.captureId).toEqual(expect.any(String));
    await expect(inbox.list()).resolves.toMatchObject({
      items: [{ id: receipt.captureId, subject: "Welcome" }],
    });

    await app.dispose();
  });

  it("owns an external transport exactly once without a provider subclass", async () => {
    const close = vi.fn(async () => undefined);
    const app = new App({}).register(
      new EmailProvider(
        emailConfig({ enabled: true }),
        defineEmailTransportAdapter({
          dependencies: {},
          capabilities: {},
          create: () => ({
            name: "external",
            send: async () => ({ status: "accepted" as const }),
            close,
          }),
          dispose: (value) => value.close(),
        }),
      ),
    );
    try {
      await expect(
        app.container
          .resolve(emailClientDependency)
          .send({
            from: "sender@example.com",
            to: "member@example.com",
            subject: "Welcome",
            text: "Hello",
          }),
      ).resolves.toMatchObject({ status: "accepted" });
    } finally {
      await app.dispose();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not register a client when email is disabled", async () => {
    const app = new App({ name: "test" }).register(
      new EmailProvider(emailConfig({ enabled: false }), memoryEmail()),
    );

    expect(app.container.hasRegistration(emailClientDependency.id)).toBe(false);
    expect(app.container.hasRegistration(emailCaptureInboxDependency.id)).toBe(false);

    await app.dispose();
  });
});

function emailConfig(input: unknown): EmailConfig {
  return emailConfigBase.schema.parse(input);
}

it("closes delivery before its owned capture backend, leaving borrowed infrastructure open", async () => {
  const order: string[] = [];
  const store = new MemoryEmailCaptureStorageAdapter();
  const app = new App({}).register(
    new EmailProvider(emailConfig({ enabled: true }), {
      ...captureEmail(
        defineEmailCaptureStorageAdapter({
          dependencies: {},
          capabilities: {},
          create: () => store,
          dispose: async () => {
            order.push("storage");
          },
        }),
        { maxMessageBytes: 1024 },
      ),
      dispose: async () => {
        order.push("delivery");
        await expect(store.list()).resolves.toBeDefined();
      },
    }),
  );
  try {
    await app.start();
  } finally {
    await app.dispose();
  }
  expect(order).toEqual(["delivery", "storage"]);
});

it("disposes capture storage before its connection even when delivery was never constructed", async () => {
  const order: string[] = [];
  const app = new App({});
  app.container.registerValue("captureConnection", {}, { dispose: async () => { order.push("connection"); } });
  app.register(new EmailProvider(emailConfig({ enabled: true }), captureEmail(defineEmailCaptureStorageAdapter({
    dependencies: { connection: dep<object>("captureConnection") }, capabilities: {},
    create: () => new MemoryEmailCaptureStorageAdapter(),
    dispose: async () => { order.push("storage"); },
  }))));
  try { await app.container.resolve(emailCaptureInboxDependency).list(); }
  finally { await app.dispose(); }
  expect(order).toEqual(["storage", "connection"]);
});
