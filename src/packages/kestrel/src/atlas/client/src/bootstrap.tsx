import { initializeAtlasAppearance, initializeAtlasFavicon } from "./appearance_runtime.js";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AtlasManifest } from "../../contract.js";
import type { AtlasClientConfig } from "../../client_config.js";
import { isAtlasLoginPath } from "./login_runtime.js";
import { getAtlasBasePath } from "./runtime.js";
import { initializeAtlasTheme } from "./theme_runtime.js";

export async function bootstrapAtlas(): Promise<Root> {
  const rootElement = document.querySelector<HTMLDivElement>("#root");

  if (rootElement === null) {
    throw new Error("Atlas could not find its root element.");
  }

  const root = createRoot(rootElement);

  try {
    // Configuration and theme setup share the same visible startup error boundary.
    const clientConfig = readClientConfig(rootElement);
    initializeAtlasAppearance(clientConfig.theme);
    initializeAtlasFavicon(clientConfig.branding);
    initializeAtlasTheme();

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

      root.render(
        <StrictMode>
          <AtlasLogin config={clientConfig} />
        </StrictMode>,
      );
      return root;
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

    root.render(
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

    root.render(
      <main className="startup-error">
        <p className="eyebrow">Atlas</p>
        <h1>Unable to load Atlas</h1>
        <p>{message}</p>
      </main>,
    );
  }
  return root;
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
