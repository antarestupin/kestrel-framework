import { smtp } from "@opencoredev/email-sdk/smtp";
import { EmailSdkEmailAdapter } from "../email_sdk/index.js";
import { defineEmailTransportAdapter } from "../../adapter_definition.js";
import type { SmtpEmailConfig } from "./configuration.js";

/** Retains validated transport settings and opens the transport only on resolution. */
export function smtpEmail(config: SmtpEmailConfig) {
  return defineEmailTransportAdapter({
    dependencies: {},
    capabilities: {},
    create: () => {
      return new EmailSdkEmailAdapter({
        adapter: smtp({
          host: config.host,
          secure: config.secure,
          requireTLS: config.requireTLS,
          allowInsecureAuth: config.allowInsecureAuth,
          timeoutMs: config.timeoutMs,
          ...(config.port === undefined ? {} : { port: config.port }),
          ...(config.auth === undefined
            ? {}
            : {
                auth: {
                  user: config.auth.user,
                  pass: config.auth.pass,
                  ...(config.auth.method === undefined ? {} : { method: config.auth.method }),
                },
              }),
          ...(config.heloName === undefined ? {} : { heloName: config.heloName }),
        }),
      });
    },
  });
}
