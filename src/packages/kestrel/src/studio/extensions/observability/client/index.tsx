import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams } from "@tanstack/react-router";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import { Icon } from "../../../client/src/ui/icon.js";
import {
  DEV_OBSERVATIONS_PAGE_KIND,
  DEV_OBSERVATION_CORRELATION_PAGE_KIND,
  DEV_OBSERVATION_LIST_PAGE_KIND,
  DEV_OBSERVATION_EXECUTION_PAGE_KIND,
  type StudioObservation,
  type StudioObservationExecution,
} from "../contract.js";
import { formatObservationDuration } from "./observation_format.js";
import { ExecutionDetails } from "./execution_details.js";
import { ObservationRow } from "./observation_row.js";

const developmentObservationsPageRenderer: StudioPageRenderer = {
  kind: DEV_OBSERVATIONS_PAGE_KIND,
  render: (page) => <DevelopmentObservationsPage page={page} />,
};

const developmentObservationExecutionPageRenderer: StudioPageRenderer = {
  kind: DEV_OBSERVATION_EXECUTION_PAGE_KIND,
  render: (page) => <DevelopmentObservationExecutionPage page={page} />,
};

const developmentObservationCorrelationPageRenderer: StudioPageRenderer = {
  kind: DEV_OBSERVATION_CORRELATION_PAGE_KIND,
  render: (page) => <DevelopmentObservationCorrelationPage page={page} />,
};

const developmentObservationListPageRenderer: StudioPageRenderer = {
  kind: DEV_OBSERVATION_LIST_PAGE_KIND,
  render: (page) => <DevelopmentObservationListPage page={page} />,
};

addStudioPageRenderer(developmentObservationsPageRenderer);
addStudioPageRenderer(developmentObservationExecutionPageRenderer);
addStudioPageRenderer(developmentObservationCorrelationPageRenderer);
addStudioPageRenderer(developmentObservationListPageRenderer);

function DevelopmentObservationsPage({
  page,
}: {
  page: StudioPageManifest;
}) {
  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined
        ? <p className="error-panel">The executions page has no data endpoint.</p>
        : <ExecutionExplorer key={page.dataPath} dataPath={page.dataPath} />}
    </div>
  );
}

function DevelopmentObservationExecutionPage({
  page,
}: {
  page: StudioPageManifest;
}) {
  const parameters: Record<string, unknown> = useParams({ strict: false });
  const { executionId } = parameters;

  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined || typeof executionId !== "string"
        ? <p className="error-panel">The execution link is incomplete.</p>
        : (
            <section
              className="observation-explorer dedicated-execution"
              aria-label="Execution details"
            >
              <ExecutionDetails
                dataPath={page.dataPath}
                executionId={executionId}
              />
            </section>
          )}
    </div>
  );
}

function DevelopmentObservationCorrelationPage({
  page,
}: {
  page: StudioPageManifest;
}) {
  const parameters: Record<string, unknown> = useParams({ strict: false });
  const { executionId, contextKey } = parameters;

  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined
        || typeof executionId !== "string"
        || typeof contextKey !== "string"
        ? <p className="error-panel">The correlation link is incomplete.</p>
        : (
            <section
              className="observation-explorer dedicated-execution"
              aria-label="Correlated execution details"
            >
              <ExecutionDetails
                contextKey={contextKey}
                dataPath={page.dataPath}
                executionId={executionId}
              />
            </section>
          )}
    </div>
  );
}

function DevelopmentObservationListPage({
  page,
}: {
  page: StudioPageManifest;
}) {
  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined
        ? <p className="error-panel">The observations page has no data endpoint.</p>
        : <ObservationListExplorer key={page.dataPath} dataPath={page.dataPath} />}
    </div>
  );
}

interface ObservationFilters {
  category: string;
  executionId: string;
  name: string;
  outcome: string;
}

const EMPTY_OBSERVATION_FILTERS: ObservationFilters = {
  category: "",
  executionId: "",
  name: "",
  outcome: "",
};

function ObservationListExplorer({ dataPath }: { dataPath: string }) {
  const [draftFilters, setDraftFilters] = useState(EMPTY_OBSERVATION_FILTERS);
  const [filters, setFilters] = useState(EMPTY_OBSERVATION_FILTERS);
  const resource = useObservationPages(`${dataPath}/observations`, observationList, filters);

  const updateDraftFilter = (
    field: keyof ObservationFilters,
    value: string,
  ) => {
    setDraftFilters((current) => ({ ...current, [field]: value }));
  };

  return (
    <section className="observation-list-explorer" aria-label="Development observations">
      <form
        className="observation-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({
            category: draftFilters.category.trim(),
            executionId: draftFilters.executionId.trim(),
            name: draftFilters.name.trim(),
            outcome: draftFilters.outcome,
          });
        }}
      >
        <label>
          Category
          <input
            onChange={(event) => updateDraftFilter("category", event.target.value)}
            placeholder="database"
            value={draftFilters.category}
          />
        </label>
        <label>
          Name
          <input
            onChange={(event) => updateDraftFilter("name", event.target.value)}
            placeholder="database.query"
            value={draftFilters.name}
          />
        </label>
        <label>
          Outcome
          <select
            onChange={(event) => updateDraftFilter("outcome", event.target.value)}
            value={draftFilters.outcome}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <label>
          Execution ID
          <input
            onChange={(event) => updateDraftFilter("executionId", event.target.value)}
            placeholder="UUID"
            value={draftFilters.executionId}
          />
        </label>
        <div className="observation-filter-actions">
          <button type="submit">Apply filters</button>
          <button
            onClick={() => {
              setDraftFilters(EMPTY_OBSERVATION_FILTERS);
              setFilters(EMPTY_OBSERVATION_FILTERS);
            }}
            type="button"
          >
            Reset
          </button>
        </div>
      </form>

      <ObservationListResults resource={resource} />
    </section>
  );
}

function ObservationListResults({ resource }: { resource: ObservationPagesResource<StudioObservation> }) {
  const nextBefore = resource.status === "ready" ? resource.nextBefore : null;
  return (
    <>
      <div className="observation-list-toolbar">
        <span>
          {resource.status === "ready"
            ? `${resource.items.length} loaded observations`
            : "Observations"}
        </span>
        <button onClick={() => void resource.clear()} type="button">
          <Icon name="delete" />
          Clear observations
        </button>
      </div>

      {resource.status === "loading" && (
        <p className="loading-panel">Loading observations…</p>
      )}
      {resource.status === "error" && (
        <p className="error-panel">{resource.message}</p>
      )}
      {resource.status === "ready" && (
        <>
          <div className="observation-list">
            {resource.items.length === 0
              ? <p className="observations-empty">No observations match these filters.</p>
              : resource.items.map((observation) => (
                  <ObservationRow
                    event={observation}
                    key={observation.id}
                    showDate
                    showExecutionLink
                  />
                ))}
          </div>
          {nextBefore !== null && (
            <button
              className="load-observations-button"
              onClick={() => void resource.loadMore(nextBefore)}
              type="button"
            >
              <Icon name="executions" />
              Load older observations
            </button>
          )}
        </>
      )}
    </>
  );
}

type ObservationPagesState<Item> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: readonly Item[];
      loadedOlder: boolean;
      nextBefore: number | null;
    };

type ObservationPagesResource<Item> = ObservationPagesState<Item> & {
  clear(): Promise<void>;
  loadMore(before: number): Promise<void>;
};

interface ObservationPageOptions<Item> {
  identity(item: Item): string;
  requestLabel: string;
  loadError: string;
}

const observationList: ObservationPageOptions<StudioObservation> = {
  identity: (observation) => observation.id,
  requestLabel: "Observations",
  loadError: "Unable to load observations.",
};
const executionList: ObservationPageOptions<StudioObservationExecution> = {
  identity: (execution) => execution.executionId,
  requestLabel: "Executions",
  loadError: "Unable to load observed executions.",
};

function useObservationPages<Item>(
  endpoint: string,
  options: ObservationPageOptions<Item>,
  filters?: ObservationFilters,
): ObservationPagesResource<Item> {
  const [state, setState] = useState<ObservationPagesState<Item>>({ status: "loading" });
  const pending = useRef<{ controller: AbortController; older: boolean } | undefined>(undefined);
  const deleting = useRef<AbortController | undefined>(undefined);
  const activeLoad = useRef<typeof load | undefined>(undefined);

  const cancelRead = useCallback(() => {
    const request = pending.current;
    pending.current = undefined;
    request?.controller.abort();
  }, []);

  const load = useCallback(async (before?: number) => {
    // Operator pagination takes precedence over polling, and a page can only be loaded once at a time.
    if (pending.current !== undefined) {
      if (before === undefined || pending.current.older) return;
      pending.current.controller.abort();
    }
    const controller = new AbortController();
    pending.current = { controller, older: before !== undefined };
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("limit", "50");

      for (const [key, value] of Object.entries(filters ?? {})) {
        if (value !== "") {
          url.searchParams.set(key, value);
        }
      }

      if (before !== undefined) {
        url.searchParams.set("before", String(before));
      }

      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${options.requestLabel} request failed with status ${response.status}.`);
      }

      const page = await response.json() as { items: readonly Item[]; nextBefore: number | null };
      if (controller.signal.aborted) return;
      setState((current) => {
        if (current.status === "ready") {
          if (before !== undefined) {
            return {
              status: "ready",
              items: mergePages(current.items, page.items, options.identity),
              loadedOlder: true,
              nextBefore: page.nextBefore,
            };
          }
          if (current.loadedOlder) {
            return { ...current, items: mergePages(page.items, current.items, options.identity) };
          }
        }
        return { status: "ready", items: page.items, loadedOlder: false, nextBefore: page.nextBefore };
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : options.loadError,
      });
    } finally {
      if (pending.current?.controller === controller) pending.current = undefined;
    }
  }, [endpoint, filters, options]);

  useEffect(() => {
    activeLoad.current = load;
    // A filter change starts a fresh page history.
    setState({ status: "loading" });
    void load();
    const interval = window.setInterval(() => {
      if (deleting.current === undefined) void load();
    }, 2_000);
    return () => {
      window.clearInterval(interval);
      cancelRead();
      activeLoad.current = undefined;
    };
  }, [cancelRead, load]);

  useEffect(() => {
    return () => {
      deleting.current?.abort();
      deleting.current = undefined;
    };
  }, []);

  const clear = useCallback(async () => {
    if (deleting.current !== undefined) return;
    const controller = new AbortController();
    deleting.current = controller;
    // A read initiated before clearing can still contain deleted observations.
    cancelRead();
    try {
      const message = await deleteObservations(endpoint, controller.signal);
      if (controller.signal.aborted) return;
      if (message !== undefined) {
        setState({ status: "error", message });
        return;
      }
      cancelRead();
      setState({ status: "loading" });
      // Clearing applies to every filter. Reload the one the operator is now viewing.
      await activeLoad.current?.();
    } finally {
      if (deleting.current === controller) deleting.current = undefined;
    }
  }, [cancelRead, endpoint]);
  const loadMore = useCallback(async (before: number) => {
    if (deleting.current === undefined) await load(before);
  }, [load]);

  return { ...state, clear, loadMore };
}

/** Preserves already loaded history while replacing the live newest page. */
function mergePages<Item>(
  first: readonly Item[],
  rest: readonly Item[],
  identity: (item: Item) => string,
): readonly Item[] {
  const ids = new Set(first.map(identity));

  return [
    ...first,
    ...rest.filter((item) => !ids.has(identity(item))),
  ];
}

function ExecutionExplorer({ dataPath }: { dataPath: string }) {
  const resource = useObservationPages(`${dataPath}/executions`, executionList);
  const [selectedId, setSelectedId] = useState<string>();
  const items = resource.status === "ready" ? resource.items : [];
  const remembered = items.find((item) => item.executionId === selectedId);
  const hasSelection = remembered !== undefined;
  const currentId = (remembered ?? items[0])?.executionId;

  // Render details from the current page immediately and remember the selection across live updates.
  useEffect(() => {
    if (!hasSelection && currentId !== undefined) setSelectedId(currentId);
  }, [currentId, hasSelection]);

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading observed executions…</p>;
  }

  if (resource.status === "error") {
    return <p className="error-panel">{resource.message}</p>;
  }

  const { nextBefore } = resource;
  return (
    <section className="observation-explorer" aria-label="Observed executions">
      <div className="observation-toolbar">
        <span>{resource.items.length} captured executions</span>
        <button onClick={() => void resource.clear()} type="button">
          <Icon name="delete" />
          Clear observations
        </button>
      </div>
      {currentId === undefined
        ? <p className="observations-empty">No executions have been observed yet.</p>
        : (
            <div className="observation-layout">
              <div className="execution-list">
                {resource.items.map((execution) => (
                  <ExecutionRow
                    execution={execution}
                    key={execution.executionId}
                    onSelect={() => setSelectedId(execution.executionId)}
                    selected={execution.executionId === currentId}
                  />
                ))}
                {nextBefore !== null && (
                  <button
                    className="load-executions-button"
                    onClick={() => void resource.loadMore(nextBefore)}
                    type="button"
                  >
                    <Icon name="executions" />
                    Load older executions
                  </button>
                )}
              </div>
              <ExecutionDetails dataPath={dataPath} executionId={currentId} />
            </div>
          )}
    </section>
  );
}

function ExecutionRow({
  execution,
  onSelect,
  selected,
}: {
  execution: StudioObservationExecution;
  onSelect(): void;
  selected: boolean;
}) {
  return (
    <button
      className={`execution-row${selected ? " selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="execution-row-heading">
        <span className={`execution-status ${execution.outcome ?? "running"}`} />
        <strong>{execution.operation}</strong>
      </span>
      <span className="execution-meta">
        <span>{execution.transport}</span>
        <time dateTime={execution.startedAt}>
          {new Date(execution.startedAt).toLocaleTimeString()}
        </time>
        <span>{formatObservationDuration(execution.durationMs)}</span>
      </span>
      <code>{execution.executionId}</code>
    </button>
  );
}

/** Both explorers surface network rejections as well as HTTP failures. */
async function deleteObservations(url: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(url, { method: "DELETE", signal });
    return response.ok ? undefined : `Clearing observations failed with status ${response.status}.`;
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to clear observations.";
  }
}
