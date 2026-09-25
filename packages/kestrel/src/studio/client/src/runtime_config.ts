import type { StudioClientConfig } from "../../client_config.js";

/** Reads the inert server-provided config shared by Studio client modules. */
export function readStudioClientConfig(): StudioClientConfig | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  const serialized = document.querySelector<HTMLDivElement>("#root")
    ?.dataset.studioConfig;

  if (serialized === undefined || serialized === "__STUDIO_CLIENT_CONFIG__") {
    return undefined;
  }

  return JSON.parse(decodeURIComponent(serialized)) as StudioClientConfig;
}
