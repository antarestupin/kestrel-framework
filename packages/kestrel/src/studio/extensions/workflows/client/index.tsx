import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import { Icon } from "../../../client/src/ui/icon.js";
import type { StudioPageManifest } from "../../../extension.js";
import {
  type StudioWorkflowCatalog,
  type StudioWorkflowControlAction,
  type StudioWorkflowExecution,
  type StudioWorkflowExecutionDetails,
  type StudioWorkflowExecutionPage,
  type StudioWorkflowGraphNode,
  WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
  WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
} from "../contract.js";
import "./styles.css";

const catalogRenderer: StudioPageRenderer = {
  kind: WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
  render: (page) => <WorkflowCatalogPage page={page} />,
};
const executionRenderer: StudioPageRenderer = {
  kind: WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
  render: (page) => <WorkflowExecutionPage page={page} />,
};

addStudioPageRenderer(catalogRenderer);
addStudioPageRenderer(executionRenderer);

function WorkflowCatalogPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page workflows-page">
      <StudioPageHeader page={page} eyebrow="Operations" badge="Durable" />
      {page.dataPath === undefined
        ? <p className="error-panel">The workflows page has no data endpoint.</p>
        : <WorkflowCatalogWorkspace dataPath={page.dataPath} />}
    </div>
  );
}

function WorkflowCatalogWorkspace({ dataPath }: { dataPath: string }) {
  const [catalog, setCatalog] = useState<StudioWorkflowCatalog>();
  const [executions, setExecutions] = useState<StudioWorkflowExecution[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [workflowName, setWorkflowName] = useState("");

  const load = useCallback(async (cursor?: string, append = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const url = new URL(`${dataPath}/executions`, window.location.origin);
      url.searchParams.set("limit", "50");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      if (search !== "") url.searchParams.set("search", search);
      if (status !== "") url.searchParams.set("status", status);
      if (workflowName !== "") url.searchParams.set("workflowName", workflowName);
      const [catalogResponse, executionsResponse] = await Promise.all([
        fetch(`${dataPath}/catalog`),
        fetch(url),
      ]);
      if (!catalogResponse.ok || !executionsResponse.ok) {
        throw new Error("Unable to load durable workflow operations.");
      }
      const nextCatalog = await catalogResponse.json() as StudioWorkflowCatalog;
      const page = await executionsResponse.json() as StudioWorkflowExecutionPage;
      setCatalog(nextCatalog);
      setExecutions((current) => append ? [...current, ...page.items] : [...page.items]);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [dataPath, search, status, workflowName]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="workflow-workspace">
      {(catalog?.unsupportedActiveVersions.length ?? 0) > 0 && (
        <section className="error-panel">
          <strong>Active executions require unavailable workflow code.</strong>
          <ul>{catalog!.unsupportedActiveVersions.map((item) => (
            <li key={`${item.workflowName}:${item.workflowVersion}`}>
              {item.workflowName}@{item.workflowVersion}: {item.count} executions ({item.reason})
            </li>
          ))}</ul>
        </section>
      )}
      <section className="workflow-definition-grid" aria-label="Workflow definitions">
        {(catalog?.definitions ?? []).map((definition) => {
          const total = definition.executions.reduce((sum, item) => sum + item.count, 0);
          const active = definition.executions.filter((item) =>
            !["cancelled", "completed", "failed", "terminated"].includes(item.status))
            .reduce((sum, item) => sum + item.count, 0);
          return (
            <article className="workflow-definition-card" key={definition.name}>
              <header>
                <strong>{definition.name}</strong>
                <span>v{definition.supportedFrom}–{definition.currentVersion}</span>
              </header>
              <p>{definition.description ?? "No description."}</p>
              <small>{active} active · {total} total · {definition.signals.length} signals</small>
            </article>
          );
        })}
      </section>

      <section className="workflow-execution-explorer" aria-label="Workflow executions">
        <form
          className="workflow-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draftSearch.trim());
          }}
        >
          <label>
            Search
            <input
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Execution, workflow or business key"
              value={draftSearch}
            />
          </label>
          <label>
            Workflow
            <select onChange={(event) => setWorkflowName(event.target.value)} value={workflowName}>
              <option value="">All definitions</option>
              {(catalog?.definitions ?? []).map((definition) => (
                <option key={definition.name} value={definition.name}>{definition.name}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select onChange={(event) => setStatus(event.target.value)} value={status}>
              <option value="">All statuses</option>
              {["blocked", "cancelled", "cancelling", "completed", "failed", "pending", "queued", "running", "terminated", "waiting"].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <div className="workflow-filter-actions">
            <button type="submit"><Icon name="view" /> Apply</button>
            <button disabled={loading} onClick={() => void load()} type="button">
              <Icon name="refresh" /> Refresh
            </button>
          </div>
        </form>

        {loading && executions.length === 0 ? <p className="loading-panel">Loading workflows…</p> : null}
        {error !== undefined ? <p className="error-panel">{error}</p> : null}
        <div className="workflow-execution-table" role="table">
          <div className="workflow-execution-row heading" role="row">
            <span>Execution</span><span>Status</span><span>Version</span><span>Updated</span><span>Relationship</span>
          </div>
          {executions.map((execution) => (
            <ExecutionRow execution={execution} key={execution.executionId} />
          ))}
        </div>
        {nextCursor !== undefined && (
          <button
            className="workflow-load-more"
            disabled={loading}
            onClick={() => void load(nextCursor, true)}
            type="button"
          >
            Load older executions
          </button>
        )}
      </section>
    </div>
  );
}

function ExecutionRow({ execution }: { execution: StudioWorkflowExecution }) {
  return (
    <Link
      className="workflow-execution-row"
      role="row"
      to={`/workflows/${encodeURIComponent(execution.executionId)}`}
    >
      <span className="workflow-execution-identity">
        <strong>{execution.workflowName}</strong>
        <code>{execution.executionId}</code>
      </span>
      <span><StatusBadge execution={execution} /></span>
      <span>v{execution.workflowVersion} · generation {execution.historyGeneration}</span>
      <span>{formatDate(execution.updatedAt)}</span>
      <span>{execution.parentExecutionId !== undefined
        ? "Child"
        : execution.retryOfExecutionId !== undefined ? "Retry" : "Root"}</span>
    </Link>
  );
}

function WorkflowExecutionPage({ page }: { page: StudioPageManifest }) {
  const parameters = useParams({ strict: false });
  const executionId = "executionId" in parameters && typeof parameters.executionId === "string"
    ? parameters.executionId
    : undefined;
  return (
    <div className="page workflows-page">
      <StudioPageHeader page={page} eyebrow="Durable workflow" badge="Execution" />
      {page.dataPath === undefined || executionId === undefined
        ? <p className="error-panel">The workflow execution link is incomplete.</p>
        : <WorkflowExecutionWorkspace dataPath={page.dataPath} executionId={executionId} />}
    </div>
  );
}

function WorkflowExecutionWorkspace({
  dataPath,
  executionId,
}: {
  dataPath: string;
  executionId: string;
}) {
  const navigate = useNavigate();
  const [details, setDetails] = useState<StudioWorkflowExecutionDetails>();
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${dataPath}/executions/${encodeURIComponent(executionId)}`);
      if (!response.ok) throw new Error(`Unable to load workflow execution (${response.status}).`);
      setDetails(await response.json() as StudioWorkflowExecutionDetails);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [dataPath, executionId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const control = async (action: StudioWorkflowControlAction) => {
    if (action === "terminate" && !window.confirm(
      "Force termination does not execute compensation code. Terminate this execution?",
    )) return;
    setUpdating(true);
    try {
      const response = await fetch(`${dataPath}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionId, action }),
      });
      const body = await response.json().catch(() => undefined) as
        | { message?: string; execution?: StudioWorkflowExecution }
        | undefined;
      if (!response.ok) throw new Error(body?.message ?? `Workflow control failed (${response.status}).`);
      if (body?.execution !== undefined) {
        await navigate({
          to: `/workflows/${encodeURIComponent(body.execution.executionId)}`,
        });
      } else {
        await load();
      }
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : String(controlError));
    } finally {
      setUpdating(false);
    }
  };

  if (details === undefined) {
    return error === undefined
      ? <p className="loading-panel">Loading execution…</p>
      : <p className="error-panel">{error}</p>;
  }
  const execution = details.execution;
  const terminal = ["cancelled", "completed", "failed", "terminated"].includes(execution.status);
  return (
    <div className="workflow-execution-details">
      {error !== undefined ? <p className="error-panel">{error}</p> : null}
      <section className="workflow-execution-hero">
        <div>
          <span className="eyebrow">{execution.workflowName}</span>
          <h2>{execution.executionId}</h2>
          <p>Version {execution.workflowVersion} · generation {execution.historyGeneration} · updated {formatDate(execution.updatedAt)}</p>
        </div>
        <StatusBadge execution={execution} />
      </section>
      <nav className="workflow-controls" aria-label="Workflow controls">
        {!terminal && (
          <button disabled={updating} onClick={() => void control(execution.pausedAt === undefined ? "pause" : "resume")} type="button">
            {execution.pausedAt === undefined ? "Pause" : "Resume"}
          </button>
        )}
        {!terminal && <button disabled={updating} onClick={() => void control("cancel")} type="button">Cancel</button>}
        {execution.status === "blocked"
          && execution.error?.name === "WorkflowExecutionVersionUnsupportedError"
          && <button disabled={updating} onClick={() => void control("recover")} type="button">Recover replay</button>}
        {execution.status === "failed" && <button disabled={updating} onClick={() => void control("retry")} type="button">Retry as new</button>}
        {!terminal && <button className="danger" disabled={updating} onClick={() => void control("terminate")} type="button">Force terminate</button>}
        <Link to={details.observationPath}>Open observations</Link>
      </nav>
      <RelationshipPanel details={details} />
      {details.waits.length > 0 && (
        <section className="workflow-waits" aria-label="Current workflow waits">
          {details.waits.map((wait) => (
            <article key={wait.sequence}>
              <small>Waiting on {wait.kind} #{wait.sequence}</small>
              <strong>{wait.target}</strong>
              <span>{wait.deadline === undefined
                ? `since ${formatDate(wait.scheduledAt)}`
                : `deadline ${formatDate(wait.deadline)}`}</span>
            </article>
          ))}
        </section>
      )}
      <SignalPanel dataPath={dataPath} details={details} onDelivered={load} />
      <section className="workflow-detail-grid">
        <PayloadPanel label="Input" value={execution.input} />
        {execution.output !== undefined ? <PayloadPanel label="Output" value={execution.output} /> : null}
        {execution.error !== undefined ? <PayloadPanel label="Error" value={execution.error} /> : null}
      </section>
      <section className="workflow-panel">
        <h3>Executed graph</h3>
        <p>The graph is derived from durable history and represents this execution path only.</p>
        <ExecutionGraph details={details} />
      </section>
      <section className="workflow-panel">
        <h3>History timeline</h3>
        <div className="workflow-timeline">
          {details.history.map((event) => (
            <article key={event.eventIndex}>
              <time>{formatDate(event.occurredAt)}</time>
              <strong>#{event.eventIndex} {event.type}</strong>
              <span>{event.kind !== undefined ? `${event.kind}: ${event.target}` : event.name ?? ""}</span>
              {event.error !== undefined ? <small>{event.error.name}: {event.error.message}</small> : null}
            </article>
          ))}
        </div>
      </section>
      {details.archives.length > 0 && (
        <section className="workflow-panel">
          <h3>Archived generations</h3>
          <ul>{details.archives.map((archive) => (
            <li key={archive.historyGeneration}>Generation {archive.historyGeneration}, version {archive.workflowVersion}: {archive.eventCount} events, continued {formatDate(archive.continuedAt)}</li>
          ))}</ul>
        </section>
      )}
    </div>
  );
}

function StatusBadge({ execution }: { execution: StudioWorkflowExecution }) {
  return (
    <span className={`workflow-status ${execution.status}`}>
      {execution.pausedAt === undefined ? execution.status : `paused · ${execution.status}`}
    </span>
  );
}

function RelationshipPanel({ details }: { details: StudioWorkflowExecutionDetails }) {
  const execution = details.execution;
  const links = [
    ...(execution.parentExecutionId === undefined
      ? []
      : [{ id: execution.parentExecutionId, label: "Parent" }]),
    ...(execution.retryOfExecutionId === undefined
      ? []
      : [{ id: execution.retryOfExecutionId, label: "Retried from" }]),
    ...details.children.map((child) => ({ id: child.executionId, label: "Child" })),
    ...details.retries.map((retry) => ({ id: retry.executionId, label: "Retry" })),
  ];
  if (links.length === 0) return null;
  return (
    <section className="workflow-relationships">
      {links.map((link) => (
        <Link key={`${link.label}:${link.id}`} to={`/workflows/${encodeURIComponent(link.id)}`}>
          <small>{link.label}</small>{link.id}
        </Link>
      ))}
    </section>
  );
}

function SignalPanel({
  dataPath,
  details,
  onDelivered,
}: {
  dataPath: string;
  details: StudioWorkflowExecutionDetails;
  onDelivered: () => Promise<void>;
}) {
  const signals = details.declaredSignals;
  const [signalName, setSignalName] = useState(signals[0] ?? "");
  const [payload, setPayload] = useState("null");
  const [message, setMessage] = useState<string>();

  if (["cancelled", "completed", "failed", "terminated"].includes(details.execution.status)) return null;
  return (
    <form
      className="workflow-signal-panel"
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        try {
          const response = await fetch(`${dataPath}/signals`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              executionId: details.execution.executionId,
              signalName,
              payload: JSON.parse(payload) as unknown,
            }),
          });
          const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
          if (!response.ok) throw new Error(body?.message ?? `Signal failed (${response.status}).`);
          setMessage("Signal delivered.");
          await onDelivered();
        } catch (signalError) {
          setMessage(signalError instanceof Error ? signalError.message : String(signalError));
        }
      }}
    >
      <h3>Send signal</h3>
      {signals.length === 0
        ? <input onChange={(event) => setSignalName(event.target.value)} placeholder="signal.name" value={signalName} />
        : (
            <select onChange={(event) => setSignalName(event.target.value)} value={signalName}>
              {signals.map((signal) => <option key={signal} value={signal}>{signal}</option>)}
            </select>
          )}
      <textarea onChange={(event) => setPayload(event.target.value)} rows={3} value={payload} />
      <button disabled={signalName.trim() === ""} type="submit">Deliver</button>
      {message !== undefined ? <small>{message}</small> : null}
    </form>
  );
}

function PayloadPanel({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="workflow-payload-panel">
      <h3>{label}</h3>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function ExecutionGraph({ details }: { details: StudioWorkflowExecutionDetails }) {
  const roots = details.graph.nodes.filter((node) => node.kind === "execution" && node.executionId === details.execution.executionId);
  const commands = details.graph.nodes.filter((node) => node.kind === "command");
  const external = details.graph.nodes.filter((node) => node.kind !== "command" && !roots.includes(node));
  return (
    <div className="workflow-graph" role="img" aria-label="Executed workflow graph">
      <div className="workflow-graph-column root">{roots.map((node) => <GraphNode key={node.id} node={node} />)}</div>
      <div className="workflow-graph-arrow">→</div>
      <div className="workflow-graph-column commands">{commands.map((node) => <GraphNode key={node.id} node={node} />)}</div>
      {external.length > 0 ? <div className="workflow-graph-arrow">→</div> : null}
      {external.length > 0 ? <div className="workflow-graph-column external">{external.map((node) => <GraphNode key={node.id} node={node} />)}</div> : null}
    </div>
  );
}

function GraphNode({ node }: { node: StudioWorkflowGraphNode }) {
  const content = (
    <article className={`workflow-graph-node ${node.kind} ${node.status}`}>
      <small>{node.kind}{node.sequence === undefined ? "" : ` #${node.sequence}`}</small>
      <strong>{node.label}</strong>
      <span>{node.status}</span>
    </article>
  );
  return node.executionId === undefined ? content : (
    <Link to={`/workflows/${encodeURIComponent(node.executionId)}`}>{content}</Link>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
