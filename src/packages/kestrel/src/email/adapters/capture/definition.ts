import { captureEmailConfigBase, type CaptureEmailConfig } from "./configuration.js";
import {
  defineEmailTransportAdapter,
  type EmailCaptureStorageAdapterDefinition,
} from "../../adapter_definition.js";
import { emailCaptureStoreDependency } from "../../dependencies.js";
import { EmailCaptureAdapter } from "./adapter.js";

/** Composes delivery into a separately selected capture backend. */
export function captureEmail(
  storage: EmailCaptureStorageAdapterDefinition,
  settings: CaptureEmailConfig = captureEmailConfigBase.schema.parse({}),
) {
  return {
    ...defineEmailTransportAdapter({
      dependencies: { store: emailCaptureStoreDependency },
      capabilities: {},
      create: ({ store }) =>
        new EmailCaptureAdapter({
          name: "local-capture",
          store,
          maxMessageBytes: settings.maxMessageBytes,
        }),
    }),
    captureStorage: storage,
  };
}
