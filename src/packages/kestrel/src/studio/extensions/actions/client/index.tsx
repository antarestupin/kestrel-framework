import { useEffect, useMemo, useState } from "react";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import {
  ACTIONS_DOCUMENTATION_PAGE_KIND,
  type DocumentedAction,
  type StudioActionCatalog,
} from "../contract.js";
import { buildActionTree, type ActionTreeNode } from "./action_tree.js";
import { ActionRunner } from "./action_runner.js";
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
      <StudioPageHeader page={page} eyebrow="Actions" />
      <ActionsListData page={page} />
    </div>
  );
}

function ActionsListData({ page }: { page: StudioPageManifest }) {
  if (page.dataPath === undefined) {
    return (
      <p className="error-panel">The actions page has no data endpoint.</p>
    );
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

  return <ActionCatalog catalog={actionsResource.catalog} />;
}

/** Keep the running action selected until its response has arrived. */
function ActionCatalog({ catalog }: { catalog: StudioActionCatalog }) {
  const { actions } = catalog;
  const [pending, setPending] = useState(false);
  const [selectedName, setSelectedName] = useState<string>();
  const nodes = useMemo(() => buildActionTree(actions), [actions]);
  const groupIds = useMemo(() => collectGroupIds(nodes), [nodes]);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const allExpanded = groupIds.every((id) => !collapsedGroups.has(id));
  // Share expansion state so individual toggles and the global control stay in sync.
  const toggleGroup = (id: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedAction =
    actions.find((action) => action.name === selectedName) ?? actions[0];

  if (selectedAction === undefined) {
    return <p className="empty-state">No action is registered.</p>;
  }

  return (
    <section className="action-explorer" aria-label="Action explorer">
      <aside className="action-tree">
        <header>
          <span>{actions.length} registered actions</span>
          {groupIds.length > 0 && (
            <button
              className="action-tree-toggle"
              type="button"
              aria-label={
                allExpanded
                  ? "Collapse all namespaces"
                  : "Expand all namespaces"
              }
              onClick={() =>
                setCollapsedGroups(new Set(allExpanded ? groupIds : []))
              }
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          )}
        </header>
        <nav aria-label="Action catalog">
          {nodes.map((node) => (
            <ActionTreeEntry
              key={`${node.kind}:${node.id}`}
              node={node}
              selectedName={selectedAction.name}
              onSelect={setSelectedName}
              disabled={pending}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
            />
          ))}
        </nav>
      </aside>
      <ActionDetails
        action={selectedAction}
        catalog={catalog}
        onPendingChange={setPending}
        key={selectedAction.name}
      />
    </section>
  );
}

/** Include nested namespaces so one click also updates groups hidden by their parents. */
function collectGroupIds(nodes: readonly ActionTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "group" ? [node.id, ...collectGroupIds(node.children)] : [],
  );
}

function ActionTreeEntry({
  node,
  selectedName,
  onSelect,
  disabled,
  collapsedGroups,
  onToggleGroup,
}: {
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  disabled: boolean;
  node: ActionTreeNode;
  selectedName: string;
  onSelect: (name: string) => void;
}) {
  if (node.kind === "group") {
    return (
      <details
        className="action-tree-group"
        open={!collapsedGroups.has(node.id)}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            onToggleGroup(node.id);
          }}
        >
          {node.name}
        </summary>
        <div>
          {node.children.map((child) => (
            <ActionTreeEntry
              key={`${child.kind}:${child.id}`}
              node={child}
              selectedName={selectedName}
              onSelect={onSelect}
              disabled={disabled}
              collapsedGroups={collapsedGroups}
              onToggleGroup={onToggleGroup}
            />
          ))}
        </div>
      </details>
    );
  }

  return (
    <button
      disabled={disabled}
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

function ActionDetails({
  action,
  catalog,
  onPendingChange,
}: {
  action: DocumentedAction;
  catalog: StudioActionCatalog;
  onPendingChange: (pending: boolean) => void;
}) {
  return (
    <article className="action-details" aria-label={action.name}>
      <header className="action-detail-heading">
        <code>{action.name}</code>
        <p>{action.description ?? "No description provided."}</p>
      </header>
      <section className="action-middleware-section">
        <h2>Middleware</h2>
        <div className="middleware-list">
          {action.middleware.length === 0 ? (
            <span className="pill">None</span>
          ) : (
            action.middleware.map((name, index) => (
              <span className="pill enabled" key={`${name}:${index}`}>
                {name}
              </span>
            ))
          )}
        </div>
      </section>
      {action.execution?.enabled === true ? (
        <ActionRunner
          action={{ ...action, execution: action.execution }}
          catalog={catalog}
          onPendingChange={onPendingChange}
        />
      ) : (
        <p className="action-runner-note">
          {action.execution?.reason ??
            "This action is available for documentation only."}
        </p>
      )}
    </article>
  );
}

type ActionsResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: StudioActionCatalog };

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

        return response.json() as Promise<StudioActionCatalog>;
      })
      .then((catalog) => {
        setResource({ status: "ready", catalog });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setResource({
          status: "error",
          message:
            error instanceof Error ? error.message : "Unable to load actions.",
        });
      });

    return () => controller.abort();
  }, [dataPath]);

  return resource;
}
