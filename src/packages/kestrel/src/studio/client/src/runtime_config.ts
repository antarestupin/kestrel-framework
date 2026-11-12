import type { StudioClientConfig } from "../../client_config.js";
import type { StudioManifest } from "../../extension.js";
import { joinStudioPath } from "../../path.js";

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

/** Loads the manifest using the same root-mount joining rule as the server. */
export async function loadStudioManifest(basePath: string): Promise<StudioManifest> {
  const response = await fetch(joinStudioPath(basePath, "/api/manifest"), {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Studio manifest request failed with status ${response.status}.`,
    );
  }

  return response.json() as Promise<StudioManifest>;
}
