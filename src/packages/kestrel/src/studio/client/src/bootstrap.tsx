import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createStudioRouter } from "./router.js";
import { loadStudioManifest, readStudioClientConfig } from "./runtime_config.js";

/**
 * Loads the server-owned extension manifest before constructing dynamic
 * TanStack routes for the registered Studio pages.
 */
export async function bootstrapStudio(): Promise<Root> {
  const rootElement = document.querySelector<HTMLDivElement>("#root");

  if (rootElement === null) {
    throw new Error("Studio could not find its root element.");
  }

  const root = createRoot(rootElement);

  try {
    // A missing or malformed document configuration must render the startup error.
    const clientConfig = readStudioClientConfig();
    if (clientConfig === undefined) {
      throw new Error("Studio client configuration was not injected.");
    }

    const manifest = await loadStudioManifest(clientConfig.basePath);
    const { RouterProvider, router } = createStudioRouter(manifest);

    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "Studio failed to start.";

    root.render(
      <main className="startup-error">
        <p className="eyebrow">Studio</p>
        <h1>Unable to load Studio</h1>
        <p>{message}</p>
      </main>,
    );
  }
  return root;
}
