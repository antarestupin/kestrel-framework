# Email

[Usage index](./README.md) · [Implementation and driver contracts](../implementation/email.md)

Use `EmailClient` for provider-neutral sending. Choose local capture for development and a configured SMTP/SES or custom driver for delivery.

## Configure a local capture inbox

Capture messages when developing or testing email flows without delivering to real recipients. The application still uses the email client, while the configured driver retains messages locally.

```ts
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { emailConfigBase, EmailProvider } from "@kestreljs/framework/email";

const configuration = createConfigurationApi({ environments: ["development"], defaultEnvironment: "development" });
const config = configuration.resolveConfig({
  email: configure(emailConfigBase, {
    enabled: true,
    driver: { type: "capture" },
    // Captured messages exist only for the lifetime of this process.
    capture: { storage: "memory" },
  }),
}, { environment: "development", env: {} });
const app = new App(config).register(new EmailProvider(config.email));
```

Inject `emailClientDependency` into actions and services. For a persistent development inbox, select `capture.storage: "postgres"`, register the database provider and install the development capture tables. Studio's email extension can display these captures.

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

## Switch to SMTP

Select SMTP when the application is ready to deliver through a mail server. Keep credentials in application configuration so deployments can supply their own account.

```ts
const smtpDefinition = configure(emailConfigBase, {
  enabled: true,
  driver: {
    type: "smtp", host: "smtp.example.com", port: 587,
    // Read credentials at configuration resolution, not in the sending code.
    auth: { user: configuration.envVar("SMTP_USER"), pass: configuration.envVar("SMTP_PASSWORD") },
  },
});
// Resolve this contribution at the application configuration boundary.
```

The provider owns client cleanup. Standalone clients must be closed explicitly. `EmailSendError` exposes a neutral code and retryable hint, but no automatic resend occurs: a transport error can happen after the provider accepted a message. Rendering, bulk personalization and delivery scheduling remain application responsibilities; [workers](./workers.md) can own asynchronous sends.

## Use cases still to document

- Configure the SES delivery driver.
- Install a PostgreSQL capture inbox, browse it in Studio and resend a captured message.
- Send to multiple recipients with CC, BCC and reply-to fields.
- Handle EmailSendError and compose asynchronous delivery with an application worker.
