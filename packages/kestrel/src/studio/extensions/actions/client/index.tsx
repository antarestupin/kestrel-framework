import {
  useEffect,
  useState,
} from "react";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import {
  ACTIONS_DOCUMENTATION_PAGE_KIND,
  type DocumentedAction,
} from "../contract.js";
import "./styles.css";

/**
 * Client renderer contributed by the actions documentation extension.
 */
const actionsDocumentationPageRenderer: StudioPageRenderer = {
  kind: ACTIONS_DOCUMENTATION_PAGE_KIND,
  render: (page) => <ActionsListPage page={page} />,
};

addStudioPageRenderer(actionsDocumentationPageRenderer);

function ActionsListPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Documentation" />
      <ActionsListData page={page} />
    </div>
  );
}

function ActionsListData({ page }: { page: StudioPageManifest }) {
  if (page.dataPath === undefined) {
    return <p className="error-panel">The actions page has no data endpoint.</p>;
  }

  return <ActionsTable dataPath={page.dataPath} />;
}

function ActionsTable({ dataPath }: { dataPath: string }) {
  const actionsResource = useActions(dataPath);

  if (actionsResource.status === "loading") {
    return <p className="loading-panel">Loading action contracts…</p>;
  }

  if (actionsResource.status === "error") {
    return <p className="error-panel">{actionsResource.message}</p>;
  }

  return (
    <section className="action-list" aria-label="Application actions">
      <div className="table-heading">
        <span>{actionsResource.actions.length} registered actions</span>
        <span>Middleware</span>
      </div>
      {actionsResource.actions.map((action) => (
        <article className="action-row" key={action.name}>
          <div>
            <code>{action.name}</code>
            <p>{action.description ?? "No description provided."}</p>
          </div>
          <div className="middleware-list">
            {action.middleware.length === 0
              ? <span className="pill">None</span>
              : action.middleware.map((name, index) => (
                  <span className="pill enabled" key={`${name}:${index}`}>{name}</span>
                ))}
          </div>
        </article>
      ))}
    </section>
  );
}

type ActionsResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; actions: readonly DocumentedAction[] };

function useActions(dataPath: string): ActionsResource {
  const [resource, setResource] = useState<ActionsResource>({
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();

    void fetch(dataPath, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Actions request failed with status ${response.status}.`,
          );
        }

        return response.json() as Promise<{
          actions: readonly DocumentedAction[];
        }>;
      })
      .then(({ actions }) => {
        setResource({ status: "ready", actions });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setResource({
          status: "error",
          message: error instanceof Error
            ? error.message
            : "Unable to load actions.",
        });
      });

    return () => controller.abort();
  }, [dataPath]);

  return resource;
}
