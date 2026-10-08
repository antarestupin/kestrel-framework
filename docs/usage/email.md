# Email

[Usage index](./README.md) · [Implementation and driver contracts](../implementation/email.md)

Use `EmailClient` for provider-neutral sending. Choose local capture for development and a configured SMTP/SES or custom driver for delivery.

## Configure a local capture inbox

Capture messages when developing or testing email flows without delivering to real recipients. The application still uses the email client, while the configured driver retains messages locally.

```ts
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { emailConfigBase, EmailProvider, captureEmail, memoryEmailCapture, captureEmailConfigBase, smtpEmail, smtpEmailConfigBase } from "@kestreljs/framework/email";

const configuration = createConfigurationApi({ environments: ["development"], defaultEnvironment: "development" });
const config = configuration.resolveConfig({
  email: configure(emailConfigBase, {
    enabled: true,
    adapter: configure(captureEmailConfigBase, {}),
  }),
}, { environment: "development", env: {} });
const app = new App(config).register(new EmailProvider(config.email, captureEmail(memoryEmailCapture(), config.email.adapter)));
```

Inject `emailClientDependency` into actions and services. For a persistent development inbox, compose `captureEmail(postgresEmailCapture(connection, storageSettings), captureSettings)`, register the borrowed PostgreSQL infrastructure and install the development capture tables. Studio's email extension can display these captures.

## Send text, HTML and attachments

Build a message when an application needs to send a notification or document. The standalone memory transport lets you exercise the complete message shape without an external service.

```ts
import { EmailClient, MemoryEmailAdapter } from "@kestreljs/framework/email";

// Standalone test transport: no message leaves the process.
const email = new EmailClient({ name: "transactional", driver: new MemoryEmailAdapter() });
try {
  // The operation name identifies this send in diagnostics without recipient details.
  const receipt = await email.send({
    from: { address: "hello@example.com", name: "Example" },
    to: "member@example.com",
    subject: "Welcome",
    text: "Welcome to the application.",
    html: "<p>Welcome to the application.</p>",
    attachments: [{ filename: "welcome.txt", content: "Welcome!" }],
  }, { operation: "member.welcome" });
} finally {
  // The standalone caller owns the client and must release its resources.
  await email.close();
}
```

Recipients accept one address or an array; CC, BCC and reply-to fields use the same address model. At least one text or HTML body is required. The stable `operation` identifies the logical send in observations without including recipient data.

You can provide `text` and `html` together: they are alternative representations of a single email, not two separate emails. The recipient's email client chooses which version to display according to its capabilities and preferences. Keep their content equivalent, using `text` for plain text and `html` for formatted content.

## Switch to SMTP

Select SMTP when the application is ready to deliver through a mail server. Keep credentials in application configuration so deployments can supply their own account.

```ts
const smtpDefinition = configure(emailConfigBase, {
  enabled: true,
  adapter: configure(smtpEmailConfigBase, {
    host: "smtp.example.com", port: 587,
    // Read credentials at configuration resolution, not in the sending code.
    auth: { user: configuration.envVar("SMTP_USER"), pass: configuration.envVar("SMTP_PASSWORD") },
  }),
});
// Resolve this contribution, then pass smtpEmail(app.config.email.adapter) to EmailProvider.
```

The provider owns client cleanup. Standalone clients must be closed explicitly. `EmailSendError` exposes a neutral code and retryable hint, but no automatic resend occurs: a transport error can happen after the provider accepted a message. Rendering, bulk personalization and delivery scheduling remain application responsibilities; [workers](./workers.md) can own asynchronous sends.

## Use cases still to document

- Configure the SES delivery driver.
- Install a PostgreSQL capture inbox, browse it in Studio and resend a captured message.
- Send to multiple recipients with CC, BCC and reply-to fields.
- Handle EmailSendError and compose asynchronous delivery with an application worker.

## External adapters and ownership

Delivery implements `EmailTransportAdapter` and is declared with `defineEmailTransportAdapter`; capture persistence implements `EmailCaptureStorageAdapter` and is declared with `defineEmailCaptureStorageAdapter`. The capture recipe composes both definitions. SMTP and SES do not require capture storage. Backend schemas live beside their factories: `smtpEmailConfigBase`, `sesEmailConfigBase`, `captureEmailConfigBase` and `postgresEmailCaptureConfigBase`.

The provider closes its client, then disposes delivery, then disposes capture storage. Injected connections remain borrowed. Minimal boot and disabled email do not create backends. External recipes supply their own initialization and disposal hooks; there is no `custom` driver name or provider subclass dispatch.
