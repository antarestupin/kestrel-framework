import {
  useEffect,
  useMemo,
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
import { buildActionTree, type ActionTreeNode } from "./action_tree.js";
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
    <div className="page actions-page">
      <StudioPageHeader page={page} eyebrow="Documentation" />
      <ActionsListData page={page} />
    </div>
  );
}

function ActionsListData({ page }: { page: StudioPageManifest }) {
  if (page.dataPath === undefined) {
    return <p className="error-panel">The actions page has no data endpoint.</p>;
  }

  return <ActionsExplorer dataPath={page.dataPath} />;
}

function ActionsExplorer({ dataPath }: { dataPath: string }) {
  const actionsResource = useActions(dataPath);

  if (actionsResource.status === "loading") {
    return <p className="loading-panel">Loading action contracts…</p>;
  }

  if (actionsResource.status === "error") {
    return <p className="error-panel">{actionsResource.message}</p>;
  }

  return <ActionCatalog actions={actionsResource.actions} />;
}

/** Keep selection separate from the detail panel so it can host an action runner later. */
function ActionCatalog({ actions }: { actions: readonly DocumentedAction[] }) {
  const [selectedName, setSelectedName] = useState<string>();
  const nodes = useMemo(() => buildActionTree(actions), [actions]);
  const selectedAction = actions.find((action) => action.name === selectedName)
    ?? actions[0];

  if (selectedAction === undefined) {
    return <p className="empty-state">No action is registered.</p>;
  }

  return (
    <section className="action-explorer" aria-label="Action explorer">
      <aside className="action-tree">
        <header>{actions.length} registered actions</header>
        <nav aria-label="Action catalog">
          {nodes.map((node) => (
            <ActionTreeEntry
              key={`${node.kind}:${node.id}`}
              node={node}
              selectedName={selectedAction.name}
              onSelect={setSelectedName}
            />
          ))}
        </nav>
      </aside>
      <ActionDetails action={selectedAction} key={selectedAction.name} />
    </section>
  );
}

function ActionTreeEntry({ node, selectedName, onSelect }: {
  node: ActionTreeNode;
  selectedName: string;
  onSelect: (name: string) => void;
}) {
  if (node.kind === "group") {
    return (
      <details className="action-tree-group" open>
        <summary>{node.name}</summary>
        <div>
          {node.children.map((child) => (
            <ActionTreeEntry
              key={`${child.kind}:${child.id}`}
              node={child}
              selectedName={selectedName}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    );
  }

  return (
    <button
      aria-current={node.id === selectedName ? "true" : undefined}
      className={node.id === selectedName ? "selected" : undefined}
      onClick={() => onSelect(node.id)}
      title={node.id}
      type="button"
    >
      {node.name}
    </button>
  );
}

function ActionDetails({ action }: { action: DocumentedAction }) {
  return (
    <article className="action-details" aria-label={action.name}>
      <header className="action-detail-heading">
        <code>{action.name}</code>
        <p>{action.description ?? "No description provided."}</p>
      </header>
      <section className="action-middleware-section">
        <h2>Middleware</h2>
        <div className="middleware-list">
          {action.middleware.length === 0
            ? <span className="pill">None</span>
            : action.middleware.map((name, index) => (
                <span className="pill enabled" key={`${name}:${index}`}>{name}</span>
              ))}
        </div>
      </section>
    </article>
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
