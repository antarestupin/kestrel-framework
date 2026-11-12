import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createStudioRouter } from "./router.js";
import { loadStudioManifest, readStudioClientConfig } from "./runtime_config.js";
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
    const manifest = await loadStudioManifest(clientConfig.basePath);
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

void bootstrapStudio();
