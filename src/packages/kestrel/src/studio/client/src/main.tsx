import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { StudioManifest } from "../../extension.js";
import { createStudioRouter } from "./router.js";
import { readStudioClientConfig } from "./runtime_config.js";
import "./styles.css";

/**
 * Loads the server-owned extension manifest before constructing dynamic
 * TanStack routes for the registered Studio pages.
 */
async function bootstrapStudio(): Promise<void> {
  const rootElement = document.querySelector<HTMLDivElement>("#root");

  if (rootElement === null) {
    throw new Error("Studio could not find its root element.");
  }

  const clientConfig = readStudioClientConfig();

  if (clientConfig === undefined) {
    throw new Error("Studio client configuration was not injected.");
  }

  try {
    const manifest = await loadManifest(clientConfig.basePath);
    const { RouterProvider, router } = createStudioRouter(manifest);

    createRoot(rootElement).render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "Studio failed to start.";

    createRoot(rootElement).render(
      <main className="startup-error">
        <p className="eyebrow">Studio</p>
        <h1>Unable to load Studio</h1>
        <p>{message}</p>
      </main>,
    );
  }
}

async function loadManifest(
  basePath: string,
): Promise<StudioManifest> {
  const response = await fetch(`${basePath}/api/manifest`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Studio manifest request failed with status ${response.status}.`,
    );
  }

  return response.json() as Promise<StudioManifest>;
}

void bootstrapStudio();
