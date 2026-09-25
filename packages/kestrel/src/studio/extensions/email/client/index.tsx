import {
  Link,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useState,
} from "react";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import { Icon } from "../../../client/src/ui/icon.js";
import type { StudioPageManifest } from "../../../extension.js";
import { getStudioObservationExecutionPath } from "../../observability/contract.js";
import {
  DEV_EMAIL_CAPTURE_PAGE_KIND,
  DEV_EMAIL_HISTORY_PAGE_KIND,
  DEV_EMAIL_INBOX_PAGE_KIND,
  getStudioEmailCapturePath,
  type StudioEmailAddress,
  type StudioEmailCaptureDetail,
  type StudioEmailCapturePage,
  type StudioEmailCaptureSummary,
  type StudioEmailHistoryItem,
  type StudioEmailHistoryPage,
  type StudioEmailResendResult,
} from "../contract.js";
import "./styles.css";

const historyRenderer: StudioPageRenderer = {
  kind: DEV_EMAIL_HISTORY_PAGE_KIND,
  render: (page) => <EmailHistoryPage page={page} />,
};
const inboxRenderer: StudioPageRenderer = {
  kind: DEV_EMAIL_INBOX_PAGE_KIND,
  render: (page) => <EmailInboxPage page={page} />,
};
const captureRenderer: StudioPageRenderer = {
  kind: DEV_EMAIL_CAPTURE_PAGE_KIND,
  render: (page) => <EmailCapturePage page={page} />,
};

addStudioPageRenderer(historyRenderer);
addStudioPageRenderer(inboxRenderer);
addStudioPageRenderer(captureRenderer);

function EmailHistoryPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page email-page">
      <StudioPageHeader page={page} eyebrow="Observability" badge="Transactional" />
      {page.dataPath === undefined
        ? <p className="error-panel">The email history page has no data endpoint.</p>
        : <EmailHistory dataPath={page.dataPath} />}
    </div>
  );
}

function EmailInboxPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page email-page">
      <StudioPageHeader page={page} eyebrow="Development email" badge="Local only" />
      {page.dataPath === undefined
        ? <p className="error-panel">The email inbox page has no data endpoint.</p>
        : <EmailInbox dataPath={page.dataPath} />}
    </div>
  );
}

function EmailCapturePage({ page }: { page: StudioPageManifest }) {
  const parameters = useParams({ strict: false });
  const captureId = "captureId" in parameters && typeof parameters.captureId === "string"
    ? parameters.captureId
    : undefined;

  return (
    <div className="page email-page">
      <StudioPageHeader page={page} eyebrow="Development email" badge="Captured" />
      {page.dataPath === undefined || captureId === undefined
        ? <p className="error-panel">The captured email link is incomplete.</p>
        : <EmailCaptureDetail dataPath={page.dataPath} captureId={captureId} />}
    </div>
  );
}

function EmailHistory({ dataPath }: { dataPath: string }) {
  const resource = usePaginatedEmailResource<StudioEmailHistoryItem>(
    `${dataPath}/history`,
  );

  return (
    <section className="email-workspace" aria-label="Email send history">
      <EmailToolbar onRefresh={resource.refresh} />
      <ResourceState resource={resource} empty="No email sends have been observed." />
      {resource.status === "ready" && resource.items.length > 0 && (
        <div className="email-table" role="table">
          <div className="email-history-row heading" role="row">
            <span>Operation</span><span>Result</span><span>Transport</span>
            <span>Duration</span><span>Recipients</span><span>Observed</span>
          </div>
          {resource.items.map((item) => <EmailHistoryRow item={item} key={item.id} />)}
        </div>
      )}
      <LoadMore resource={resource} />
    </section>
  );
}

function EmailHistoryRow({ item }: { item: StudioEmailHistoryItem }) {
  const content = (
    <>
      <span className="email-identity">
        <strong>{item.operation ?? "Unknown operation"}</strong>
        <code>{item.id}</code>
      </span>
      <span><ResultBadge result={item.result} outcome={item.outcome} /></span>
      <span>{item.transport ?? "Unknown"}</span>
      <span>{formatDuration(item.durationMs)}</span>
      <span>{item.recipientCount ?? 0}</span>
      <span>{formatDate(item.occurredAt)}</span>
    </>
  );

  return item.captureId === null
    ? (
        <Link
          className="email-history-row"
          role="row"
          to={getStudioObservationExecutionPath(item.executionId)}
        >
          {content}
        </Link>
      )
    : (
        <Link
          className="email-history-row"
          role="row"
          to={getStudioEmailCapturePath(item.captureId)}
        >
          {content}
        </Link>
      );
}

function EmailInbox({ dataPath }: { dataPath: string }) {
  const resource = usePaginatedEmailResource<StudioEmailCaptureSummary>(
    `${dataPath}/captures`,
  );
  const clear = async () => {
    if (!window.confirm("Clear every locally captured email? This cannot be undone.")) return;
    const response = await fetch(`${dataPath}/captures`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Unable to clear the inbox (${response.status}).`);
    await resource.refresh();
  };

  return (
    <section className="email-workspace" aria-label="Local email capture inbox">
      <EmailToolbar onRefresh={resource.refresh} onClear={clear} />
      <ResourceState resource={resource} empty="No emails have been captured locally." />
      {resource.status === "ready" && resource.items.length > 0 && (
        <div className="email-inbox-list">
          {resource.items.map((capture) => (
            <Link
              className="email-inbox-row"
              key={capture.id}
              to={getStudioEmailCapturePath(capture.id)}
            >
              <span className="email-avatar">{addressInitial(capture.from)}</span>
              <span className="email-inbox-content">
                <strong>{formatAddress(capture.from)}</strong>
                <span>{capture.subject}</span>
                <small>To {capture.to.map(formatAddress).join(", ")}</small>
              </span>
              <span className="email-inbox-meta">
                <time>{formatDate(capture.capturedAt)}</time>
                <small>{capture.attachmentCount === 0
                  ? "No attachments"
                  : `${capture.attachmentCount} attachments · ${formatBytes(capture.attachmentBytes)}`}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
      <LoadMore resource={resource} />
    </section>
  );
}

function EmailCaptureDetail({
  dataPath,
  captureId,
}: {
  dataPath: string;
  captureId: string;
}) {
  const navigate = useNavigate();
  const [capture, setCapture] = useState<StudioEmailCaptureDetail>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<"html" | "text">("html");
  const [resending, setResending] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `${dataPath}/captures/${encodeURIComponent(captureId)}`,
      );
      if (!response.ok) throw new Error(`Unable to load captured email (${response.status}).`);
      const nextCapture = await response.json() as StudioEmailCaptureDetail;
      setCapture(nextCapture);
      setPreview((current) => {
        if (current === "html" && nextCapture.html === null) return "text";
        if (current === "text" && nextCapture.text === null && nextCapture.html !== null) {
          return "html";
        }
        return current;
      });
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [captureId, dataPath]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const resend = async () => {
    if (!window.confirm(
      "Replay this message through the configured local email transport using its original recipients?",
    )) return;
    setResending(true);
    try {
      const response = await fetch(
        `${dataPath}/captures/${encodeURIComponent(captureId)}/resend`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`Unable to resend captured email (${response.status}).`);
      const result = await response.json() as StudioEmailResendResult;
      if (result.captureId !== null) {
        await navigate({ to: getStudioEmailCapturePath(result.captureId) });
      } else {
        await load();
      }
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : String(resendError));
    } finally {
      setResending(false);
    }
  };

  if (error !== undefined) return <p className="error-panel">{error}</p>;
  if (capture === undefined) return <p className="loading-panel">Loading captured email…</p>;

  return (
    <section className="email-detail" aria-label="Captured email detail">
      <header className="email-detail-header">
        <div>
          <h2>{capture.subject}</h2>
          <p>From <strong>{formatAddress(capture.from)}</strong></p>
          <p>To {capture.to.map(formatAddress).join(", ")}</p>
          {capture.cc.length > 0 && <p>Cc {capture.cc.map(formatAddress).join(", ")}</p>}
          {capture.bcc.length > 0 && <p>Bcc {capture.bcc.map(formatAddress).join(", ")}</p>}
        </div>
        <button disabled={resending} onClick={() => void resend()} type="button">
          <Icon name={resending ? "loading" : "retry"} spin={resending} />
          {resending ? "Resending…" : "Resend"}
        </button>
      </header>

      <ObservationCard capture={capture} />

      <div className="email-preview-toolbar">
        <button
          className={preview === "html" ? "active" : ""}
          disabled={capture.html === null}
          onClick={() => setPreview("html")}
          type="button"
        >
          HTML
        </button>
        <button
          className={preview === "text" ? "active" : ""}
          disabled={capture.text === null}
          onClick={() => setPreview("text")}
          type="button"
        >
          Text
        </button>
      </div>
      <div className="email-preview">
        {preview === "html" && capture.html !== null
          ? (
              <iframe
                referrerPolicy="no-referrer"
                sandbox=""
                srcDoc={sandboxHtml(capture.html)}
                title={`HTML preview for ${capture.subject}`}
              />
            )
          : <pre>{capture.text ?? "No text body."}</pre>}
      </div>

      <section className="email-detail-grid">
        <article>
          <h3>Attachments</h3>
          {capture.attachments.length === 0
            ? <p>No attachments.</p>
            : (
                <ul>{capture.attachments.map((attachment, index) => (
                  <li key={`${attachment.filename}:${index}`}>
                    <strong>{attachment.filename}</strong>
                    <span>{attachment.contentType ?? "Unknown type"} · {formatBytes(attachment.size)}</span>
                    {attachment.contentId !== null && <code>cid:{attachment.contentId}</code>}
                  </li>
                ))}</ul>
              )}
        </article>
        <article>
          <h3>Message metadata</h3>
          <dl>
            <dt>Captured</dt><dd>{formatDate(capture.capturedAt)}</dd>
            <dt>Capture ID</dt><dd><code>{capture.id}</code></dd>
            <dt>Observation ID</dt><dd><code>{capture.observationId}</code></dd>
          </dl>
          <details>
            <summary>Headers ({Object.keys(capture.headers).length})</summary>
            <pre>{JSON.stringify(capture.headers, null, 2)}</pre>
          </details>
        </article>
      </section>
    </section>
  );
}

function ObservationCard({ capture }: { capture: StudioEmailCaptureDetail }) {
  const observation = capture.observation;
  if (observation === null) {
    return (
      <aside className="email-observation pending">
        <Icon name="loading" spin />
        The linked observation is pending, disabled or expired.
      </aside>
    );
  }

  return (
    <Link
      className="email-observation"
      to={getStudioObservationExecutionPath(observation.executionId)}
    >
      <span><ResultBadge result={observation.result} outcome={observation.outcome} /></span>
      <span><strong>{observation.operation ?? "Email send"}</strong><small>View execution</small></span>
      <span>{observation.transport ?? "Unknown transport"}</span>
      <span>{formatDuration(observation.durationMs)}</span>
    </Link>
  );
}

function EmailToolbar({
  onRefresh,
  onClear,
}: {
  onRefresh(): Promise<void>;
  onClear?: () => Promise<void>;
}) {
  return (
    <div className="email-toolbar">
      <button onClick={() => void onRefresh()} type="button">
        <Icon name="refresh" /> Refresh
      </button>
      {onClear !== undefined && (
        <button className="danger" onClick={() => void onClear()} type="button">
          <Icon name="delete" /> Clear inbox
        </button>
      )}
    </div>
  );
}

type PaginatedResource<Item> =
  | { status: "loading"; items: readonly Item[]; nextBefore: number | null; refresh(): Promise<void>; loadMore(): Promise<void> }
  | { status: "error"; message: string; items: readonly Item[]; nextBefore: number | null; refresh(): Promise<void>; loadMore(): Promise<void> }
  | { status: "ready"; items: readonly Item[]; nextBefore: number | null; refresh(): Promise<void>; loadMore(): Promise<void> };

function usePaginatedEmailResource<Item>(url: string): PaginatedResource<Item> {
  const [state, setState] = useState<{
    status: "error" | "loading" | "ready";
    message?: string;
    items: readonly Item[];
    nextBefore: number | null;
  }>({ status: "loading", items: [], nextBefore: null });
  const load = useCallback(async (before?: number) => {
    try {
      const requestUrl = new URL(url, window.location.origin);
      requestUrl.searchParams.set("limit", "50");
      if (before !== undefined) requestUrl.searchParams.set("before", String(before));
      const response = await fetch(requestUrl);
      if (!response.ok) throw new Error(`Email request failed (${response.status}).`);
      const page = await response.json() as { items: readonly Item[]; nextBefore: number | null };
      setState((current) => ({
        status: "ready",
        items: before === undefined ? page.items : [...current.items, ...page.items],
        nextBefore: page.nextBefore,
      }));
    } catch (error: unknown) {
      setState((current) => ({
        ...current,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [url]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const refresh = useCallback(() => load(), [load]);
  const loadMore = useCallback(async () => {
    if (state.nextBefore !== null) await load(state.nextBefore);
  }, [load, state.nextBefore]);

  if (state.status === "error") {
    return { ...state, status: "error", message: state.message ?? "Unable to load email data.", refresh, loadMore };
  }
  return { ...state, refresh, loadMore } as PaginatedResource<Item>;
}

function ResourceState<Item>({
  resource,
  empty,
}: {
  resource: PaginatedResource<Item>;
  empty: string;
}) {
  if (resource.status === "loading") return <p className="loading-panel">Loading email data…</p>;
  if (resource.status === "error") return <p className="error-panel">{resource.message}</p>;
  return resource.items.length === 0 ? <p className="email-empty">{empty}</p> : null;
}

function LoadMore<Item>({ resource }: { resource: PaginatedResource<Item> }) {
  return resource.nextBefore === null
    ? null
    : <button className="email-load-more" onClick={() => void resource.loadMore()} type="button">Load older</button>;
}

function ResultBadge({ result, outcome }: Pick<StudioEmailHistoryItem, "result" | "outcome">) {
  return <span className={`email-result ${outcome ?? "unknown"}`}>{result ?? outcome ?? "unknown"}</span>;
}

function formatAddress(address: StudioEmailAddress): string {
  return address.name === null
    ? address.address
    : `${address.name} <${address.address}>`;
}

function addressInitial(address: StudioEmailAddress): string {
  return (address.name ?? address.address).trim().charAt(0).toUpperCase() || "@";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000 ? `${value.toFixed(1)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function sandboxHtml(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: cid:; style-src 'unsafe-inline'"><meta name="color-scheme" content="light dark"></head><body>${html}</body></html>`;
}
