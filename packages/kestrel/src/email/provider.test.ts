import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  App,
  type ProviderCompositionApp,
} from "../app/index.js";
import {
  AsyncLocalObserverContext,
  type Observer,
} from "../observability/index.js";
import { emailConfigBase, type EmailConfig } from "./configuration.js";
import {
  emailCaptureInboxDependency,
  emailClientDependency,
} from "./dependencies.js";
import { EmailProvider } from "./provider.js";
import type { EmailDriver } from "./types.js";

describe("EmailProvider", () => {
  it("records through the observer active for the execution", async () => {
    const observerContext = new AsyncLocalObserverContext();
    const observer = { record: vi.fn() } as unknown as Observer;
    const app = new App({ name: "test" });

    app.container.registerValue("observerContext", observerContext);
    app.register(new EmailProvider(emailConfig({
      enabled: true,
      name: "transactional",
      driver: { type: "memory" },
    })));

    const client = app.container.resolve(emailClientDependency);
    await observerContext.run(observer, () => client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    }, { operation: "member.welcome" }));

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
      new EmailProvider(emailConfig({
        enabled: true,
        driver: { type: "capture" },
        capture: {
          storage: "memory",
          maxMessageBytes: 1_024,
          retentionDays: 2,
        },
      })),
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

  it.each(["smtp", "ses"] as const)(
    "selects the %s driver from configuration",
    async (driverType) => {
      const send = vi.fn(async () => ({ status: "accepted" as const }));
      class SelectedDriverProvider extends EmailProvider<{ name: string }> {
        protected override createSmtpDriver(): EmailDriver {
          return { name: "selected-smtp", send };
        }

        protected override createSesDriver(): EmailDriver {
          return { name: "selected-ses", send };
        }
      }
      const driver = driverType === "smtp"
        ? {
            type: "smtp" as const,
            host: "smtp.example.test",
          }
        : {
            type: "ses" as const,
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
            region: "eu-west-1",
          };
      const app = new App({ name: "test" }).register(
        new SelectedDriverProvider(emailConfig({ enabled: true, driver })),
      );

      await app.container.resolve(emailClientDependency).send({
        from: "sender@example.com",
        to: "member@example.com",
        subject: "Welcome",
        text: "Hello",
      });

      expect(send).toHaveBeenCalledOnce();
      await app.dispose();
    },
  );

  it("supports an application-specific driver through a subclass", async () => {
    const close = vi.fn(async () => undefined);
    class CustomEmailProvider extends EmailProvider<{ name: string }> {
      protected override createCustomDriver(
        _app: ProviderCompositionApp<{ name: string }>,
        name: string,
      ): EmailDriver {
        return {
          name,
          send: async () => ({ status: "accepted" }),
          close,
        };
      }
    }
    const app = new App({ name: "test" }).register(
      new CustomEmailProvider(emailConfig({
        enabled: true,
        driver: { type: "custom", name: "mailjet" },
      })),
    );
    const client = app.container.resolve(emailClientDependency);

    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    })).resolves.toMatchObject({ status: "accepted" });
    await app.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it("does not register a client when email is disabled", async () => {
    const app = new App({ name: "test" }).register(
      new EmailProvider(emailConfig({ enabled: false })),
    );

    expect(
      app.container.hasRegistration(emailClientDependency.id),
    ).toBe(false);
    expect(
      app.container.hasRegistration(emailCaptureInboxDependency.id),
    ).toBe(false);

    await app.dispose();
  });
});

function emailConfig(input: unknown): EmailConfig {
  return emailConfigBase.schema.parse(input);
}
