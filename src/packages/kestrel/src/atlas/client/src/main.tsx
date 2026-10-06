import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { AtlasManifest } from "../../contract.js";
import type { AtlasClientConfig } from "../../client_config.js";
import { isAtlasLoginPath } from "./login_runtime.js";
import { getAtlasBasePath } from "./runtime.js";
import { initializeAtlasTheme } from "./theme_runtime.js";
import "./styles.css";

async function bootstrapAtlas(): Promise<void> {
  const rootElement = document.querySelector<HTMLDivElement>("#root");

  if (rootElement === null) {
    throw new Error("Atlas could not find its root element.");
  }

  const clientConfig = readClientConfig(rootElement);

  try {
    if (
      clientConfig.authentication !== undefined
      && isAtlasLoginPath(
        window.location.pathname,
        clientConfig.authentication,
      )
    ) {
      // Authentication stays independent from the resource application so a
      // login visit does not download the router, Query, or resource screens.
      const { AtlasLogin } = await import("./login.js");

      createRoot(rootElement).render(
        <StrictMode>
          <AtlasLogin config={clientConfig} />
        </StrictMode>,
      );
      return;
    }

    const manifest = await loadManifest(clientConfig.basePath);
    const [query, application] = await Promise.all([
      import("@tanstack/react-query"),
      import("./app.js"),
    ]);
    const { QueryClient, QueryClientProvider } = query;
    const { AtlasApplication } = application;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 15_000, retry: 1 },
      },
    });

    createRoot(rootElement).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <AtlasApplication
            authentication={clientConfig.authentication}
            manifest={manifest}
          />
        </QueryClientProvider>
      </StrictMode>,
    );
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "Atlas failed to start.";

    createRoot(rootElement).render(
      <main className="startup-error">
        <p className="eyebrow">Atlas</p>
        <h1>Unable to load Atlas</h1>
        <p>{message}</p>
      </main>,
    );
  }
}

function readClientConfig(
  rootElement: HTMLDivElement,
): AtlasClientConfig {
  const serialized = rootElement.dataset.atlasConfig;

  if (
    serialized === undefined
    || serialized === "__ATLAS_CLIENT_CONFIG__"
  ) {
    throw new Error("Atlas client configuration was not injected.");
  }

  return JSON.parse(decodeURIComponent(serialized)) as AtlasClientConfig;
}

async function loadManifest(basePath: string): Promise<AtlasManifest> {
  const response = await fetch(
    `${getAtlasBasePath(basePath)}/api/manifest`,
    { headers: { accept: "application/json" } },
  );

  if (!response.ok) {
    throw new Error(
      `Atlas manifest request failed with status ${response.status}.`,
    );
  }

  return response.json() as Promise<AtlasManifest>;
}

initializeAtlasTheme();
void bootstrapAtlas();
