import {
  type CSSProperties,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  Link,
  useParams,
} from "@tanstack/react-router";

import { createUuid } from "../../../../utils/uuid.js";
import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import { Icon } from "../../../client/src/ui/icon.js";
import { ExecutionTimeline } from "../../observability/client/timeline.js";
import {
  getStudioWorkerPath,
  type StudioWorkerCatalog,
  type StudioWorkerCatalogNode,
  type StudioWorkerDetail,
  type StudioWorkerEnqueueResult,
  type StudioWorkerObservability,
  type StudioWorkerQueue,
  WORKER_STUDIO_PAGE_KIND,
  WORKERS_STUDIO_PAGE_KIND,
} from "../contract.js";
import "./styles.css";

type CatalogResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: StudioWorkerCatalog };

interface WorkerCatalogRow {
  node: StudioWorkerCatalogNode;
  depth: number;
}

const workersStudioPageRenderer: StudioPageRenderer = {
  kind: WORKERS_STUDIO_PAGE_KIND,
  render: (page) => <WorkersStudioPage page={page} />,
};

const workerStudioPageRenderer: StudioPageRenderer = {
  kind: WORKER_STUDIO_PAGE_KIND,
  render: (page) => <WorkerStudioPage page={page} />,
};

addStudioPageRenderer(workersStudioPageRenderer);
addStudioPageRenderer(workerStudioPageRenderer);

function WorkersStudioPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page workers-page">
      <StudioPageHeader page={page} eyebrow="Operations" badge="Interactive" />
      {page.dataPath === undefined
        ? <p className="error-panel">The workers page has no data endpoint.</p>
        : <WorkerWorkspace dataPath={page.dataPath} />}
    </div>
  );
}

function WorkerWorkspace({ dataPath }: { dataPath: string }) {
  const [resource, setResource] = useState<CatalogResource>({ status: "loading" });
  const [updatingQueue, setUpdatingQueue] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${dataPath}/catalog`);

      if (!response.ok) {
        throw new Error(`Unable to load worker queues (${response.status}).`);
      }

      const catalog = await response.json() as StudioWorkerCatalog;
      setResource({ status: "ready", catalog });
    } catch (error) {
      setResource({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dataPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const setEnabled = async (worker: StudioWorkerQueue, enabled: boolean) => {
    setUpdatingQueue(worker.queue);

    try {
      const response = await fetch(`${dataPath}/queues/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue: worker.queue, enabled }),
      });

      if (!response.ok) {
        throw new Error(`Unable to update the queue (${response.status}).`);
      }

      await load();
    } catch (error) {
      setResource({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpdatingQueue(undefined);
    }
  };

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading worker queues…</p>;
  }

  if (resource.status === "error") {
    return (
      <div className="workers-error error-panel">
        <span>{resource.message}</span>
        <button onClick={() => void load()} type="button">
          <Icon name="retry" />
          Retry
        </button>
      </div>
    );
  }

  const rows = flattenCatalogRows(resource.catalog.nodes);
  const workers = rows.flatMap((row) =>
    row.node.kind === "worker" ? [row.node] : []);

  return (
    <section className="worker-queues" aria-label="Worker queues">
      <header className="worker-queue-summary">
        <span>{workers.length} registered queues</span>
        <button onClick={() => void load()} type="button">
          <Icon name="refresh" />
          Refresh
        </button>
      </header>
      <div className="worker-queue-table" role="table">
        <div className="worker-queue-row heading" role="row">
          <span>Worker</span>
          <span>Waiting</span>
          <span>Ready</span>
          <span>Scheduled</span>
          <span>Running</span>
          <span>Status</span>
        </div>
        {rows.map(({ node, depth }) =>
          node.kind === "group"
            ? (
                <div
                  className="worker-group-row"
                  key={node.id}
                  role="row"
                  style={{ "--worker-depth": depth } as CSSProperties}
                >
                  <span>{node.name}</span>
                </div>
              )
            : (
                <div
                  className="worker-queue-row"
                  key={node.id}
                  role="row"
                >
                  <Link
                    className="worker-identity"
                    style={{ "--worker-depth": depth } as CSSProperties}
                    to={getStudioWorkerPath(node.id)}
                  >
                    <strong>{node.name}</strong>
                    <code>{node.queue}</code>
                    {node.description !== undefined && <small>{node.description}</small>}
                  </Link>
                  <strong>{node.ready + node.scheduled}</strong>
                  <span>{node.ready}</span>
                  <span>{node.scheduled}</span>
                  <span>{node.reserved}</span>
                  <button
                    className={`queue-toggle ${node.enabled ? "enabled" : "paused"}`}
                    disabled={updatingQueue === node.queue}
                    onClick={() => void setEnabled(node, !node.enabled)}
                    type="button"
                  >
                    <Icon
                      name={updatingQueue === node.queue
                        ? "loading"
                        : node.enabled ? "play" : "pause"}
                      spin={updatingQueue === node.queue}
                    />
                    {updatingQueue === node.queue
                      ? "Updating…"
                      : node.enabled ? "Active" : "Paused"}
                  </button>
                </div>
              ))}
      </div>
    </section>
  );
}

function WorkerStudioPage({ page }: { page: StudioPageManifest }) {
  const parameters = useParams({ strict: false });
  const workerId = "workerId" in parameters
    && typeof parameters.workerId === "string"
    ? parameters.workerId
    : undefined;

  return (
    <div className="page workers-page">
      <StudioPageHeader page={page} eyebrow="Operations" badge="Interactive" />
      {page.dataPath === undefined || workerId === undefined
        ? <p className="error-panel">The worker link is incomplete.</p>
        : <WorkerDetailWorkspace dataPath={page.dataPath} workerId={workerId} />}
    </div>
  );
}

type WorkerDetailResource =
  | { status: "loading" }
  | { status: "error"; message: string; notFound: boolean }
  | { status: "ready"; detail: StudioWorkerDetail };

function WorkerDetailWorkspace({
  dataPath,
  workerId,
}: {
  dataPath: string;
  workerId: string;
}) {
  const [resource, setResource] = useState<WorkerDetailResource>({
    status: "loading",
  });
  const [updatingQueue, setUpdatingQueue] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [controlError, setControlError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `${dataPath}/catalog/${encodeURIComponent(workerId)}`,
        { headers: { accept: "application/json" } },
      );

      if (!response.ok) {
        setResource({
          status: "error",
          message: response.status === 404
            ? "This worker is no longer registered."
            : `Unable to load the worker (${response.status}).`,
          notFound: response.status === 404,
        });
        return;
      }

      const detail = await response.json() as StudioWorkerDetail;
      setResource({ status: "ready", detail });
    } catch (error) {
      setResource({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        notFound: false,
      });
    }
  }, [dataPath, workerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    if (resource.status !== "ready") {
      return;
    }

    setUpdatingQueue(true);
    setControlError(undefined);

    try {
      const response = await fetch(`${dataPath}/queues/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queue: resource.detail.worker.queue,
          enabled,
        }),
      });

      if (!response.ok) {
        throw new Error(`Unable to update the queue (${response.status}).`);
      }

      await load();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingQueue(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);

    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading worker…</p>;
  }

  if (resource.status === "error") {
    return (
      <div className="worker-detail-error error-panel">
        <p>{resource.message}</p>
        {resource.notFound
          ? <Link to="/workers">Return to workers</Link>
          : <button onClick={() => void load()} type="button">
              <Icon name="retry" />
              Retry
            </button>}
      </div>
    );
  }

  return (
    <>
      <Link className="workers-back-link" to="/workers">
        <Icon name="previous" />
        All workers
      </Link>
      <WorkerPublisher
        dataPath={dataPath}
        controlError={controlError}
        observability={resource.detail.observability}
        onEnqueued={load}
        onRefresh={refresh}
        onSetEnabled={setEnabled}
        queueUpdating={updatingQueue}
        refreshing={refreshing}
        worker={resource.detail.worker}
      />
    </>
  );
}

function WorkerPublisher({
  controlError,
  dataPath,
  observability,
  onEnqueued,
  onRefresh,
  onSetEnabled,
  queueUpdating,
  refreshing,
  worker,
}: {
  controlError: string | undefined;
  dataPath: string;
  observability: StudioWorkerObservability | undefined;
  onEnqueued(): Promise<void>;
  onRefresh(): Promise<void>;
  onSetEnabled(enabled: boolean): Promise<void>;
  queueUpdating: boolean;
  refreshing: boolean;
  worker: StudioWorkerQueue;
}) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [payload, setPayload] = useState(
    () => formatPayload(worker, 0),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<StudioWorkerEnqueueResult>();
  const [executionId, setExecutionId] = useState<string>();

  const selectExample = (index: number) => {
    setExampleIndex(index);
    setPayload(formatPayload(worker, index));
    setError(undefined);
    setResult(undefined);
    setExecutionId(undefined);
  };

  const enqueue = async () => {
    setSending(true);
    setError(undefined);
    setResult(undefined);
    setExecutionId(undefined);

    try {
      const parsedPayload = JSON.parse(payload) as unknown;
      const requestedExecutionId = createUuid();

      setExecutionId(requestedExecutionId);

      const response = await fetch(`${dataPath}/enqueue`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          queue: worker.queue,
          payload: parsedPayload,
          executionId: requestedExecutionId,
        }),
      });

      if (!response.ok) {
        const responseBody = await response.text();

        throw new Error(formatEnqueueError(response.status, responseBody));
      }

      const enqueueResult = await response.json() as StudioWorkerEnqueueResult;
      setExecutionId(enqueueResult.executionId);
      setResult(enqueueResult);
      await onEnqueued();
    } catch (caught) {
      setExecutionId(undefined);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="worker-publisher">
      <header>
        <div>
          <p className="eyebrow">Publish job</p>
          <h2>{worker.name}</h2>
          <code>{worker.queue}</code>
          {worker.description !== undefined && <p>{worker.description}</p>}
        </div>
        <span className="worker-header-actions">
          <button
            disabled={refreshing}
            onClick={() => void onRefresh()}
            type="button"
          >
            <Icon name={refreshing ? "loading" : "refresh"} spin={refreshing} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className={`queue-toggle ${worker.enabled ? "enabled" : "paused"}`}
            disabled={queueUpdating}
            onClick={() => void onSetEnabled(!worker.enabled)}
            type="button"
          >
            <Icon
              name={queueUpdating
                ? "loading"
                : worker.enabled ? "play" : "pause"}
              spin={queueUpdating}
            />
            {queueUpdating
              ? "Updating…"
              : worker.enabled ? "Active" : "Paused"}
          </button>
        </span>
      </header>

      {controlError !== undefined && (
        <p className="worker-control-error">{controlError}</p>
      )}

      <div className="worker-detail-stats" aria-label="Queue state">
        <span><small>Waiting</small><strong>{worker.ready + worker.scheduled}</strong></span>
        <span><small>Ready</small><strong>{worker.ready}</strong></span>
        <span><small>Scheduled</small><strong>{worker.scheduled}</strong></span>
        <span><small>Running</small><strong>{worker.reserved}</strong></span>
      </div>

      {worker.examples.length > 0 && (
        <label className="worker-example-picker">
          <span>Example</span>
          <select
            onChange={(event) => selectExample(Number(event.target.value))}
            value={exampleIndex}
          >
            {worker.examples.map((example, index) => (
              <option key={`${example.name}:${index}`} value={index}>
                {example.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="worker-payload-editor">
        <span>JSON payload</span>
        <textarea
          onChange={(event) => setPayload(event.target.value)}
          spellCheck={false}
          value={payload}
        />
      </label>

      <div className="worker-enqueue-row">
        <button disabled={sending} onClick={() => void enqueue()} type="button">
          <Icon name={sending ? "loading" : "create"} spin={sending} />
          {sending ? "Enqueuing…" : "Enqueue job"}
        </button>
        {result !== undefined && (
          <p className="worker-enqueue-success">
            Enqueued job <code>{result.jobId}</code>
          </p>
        )}
        {error !== undefined && <p className="worker-enqueue-error">{error}</p>}
      </div>

      {observability !== undefined && executionId !== undefined && (
        <section className="worker-observations">
          <ExecutionTimeline
            dataPath={observability.dataPath}
            executionId={executionId}
            key={executionId}
            pollTimeoutMs={null}
            pollUntilCompleted
            requestPending={sending}
          />
        </section>
      )}
    </section>
  );
}

function flattenCatalogRows(
  nodes: readonly StudioWorkerCatalogNode[],
  depth = 0,
): readonly WorkerCatalogRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "group"
      ? flattenCatalogRows(node.children, depth + 1)
      : []),
  ]);
}

function formatPayload(worker: StudioWorkerQueue, exampleIndex: number): string {
  return JSON.stringify(worker.examples[exampleIndex]?.payload ?? {}, null, 2);
}

function formatEnqueueError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };

    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Non-JSON error bodies fall back to the status-based message below.
  }

  return `Unable to enqueue the worker job (${status}).`;
}
