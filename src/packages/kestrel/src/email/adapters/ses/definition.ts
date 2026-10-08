import { ses } from "@opencoredev/email-sdk/ses";
import { EmailSdkEmailAdapter } from "../email_sdk/index.js";
import { defineEmailTransportAdapter } from "../../adapter_definition.js";
import type { SesEmailConfig } from "./configuration.js";

/** Retains validated transport settings and opens the transport only on resolution. */
export function sesEmail(config: SesEmailConfig) {
  return defineEmailTransportAdapter({
    dependencies: {},
    capabilities: {},
    create: () => {
      return new EmailSdkEmailAdapter({
        adapter: ses({
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          region: config.region,
          charset: config.charset,
          ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.configurationSetName === undefined
            ? {}
            : { configurationSetName: config.configurationSetName }),
        }),
      });
    },
  });
}
