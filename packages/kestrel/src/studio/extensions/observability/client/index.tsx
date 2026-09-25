import {
  useCallback,
  useEffect,
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
  type StudioObservationExecutionPage,
  type StudioObservationPage,
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
        : <ExecutionExplorer dataPath={page.dataPath} />}
    </div>
  );
}

function DevelopmentObservationExecutionPage({
  page,
}: {
  page: StudioPageManifest;
}) {
  const parameters = useParams({ strict: false });
  const executionId = "executionId" in parameters
    && typeof parameters.executionId === "string"
    ? parameters.executionId
    : undefined;

  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined || executionId === undefined
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
  const parameters = useParams({ strict: false });
  const executionId = "executionId" in parameters
    && typeof parameters.executionId === "string"
    ? parameters.executionId
    : undefined;
  const contextKey = "contextKey" in parameters
    && typeof parameters.contextKey === "string"
    ? parameters.contextKey
    : undefined;

  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined
        || executionId === undefined
        || contextKey === undefined
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
        : <ObservationListExplorer dataPath={page.dataPath} />}
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
  const resource = useObservations(dataPath, filters);

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
          {resource.nextBefore !== null && (
            <button
              className="load-observations-button"
              onClick={() => void resource.loadMore()}
              type="button"
            >
              <Icon name="executions" />
              Load older observations
            </button>
          )}
        </>
      )}
    </section>
  );
}

type ObservationsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: readonly StudioObservation[];
      loadedOlder: boolean;
      nextBefore: number | null;
    };

function useObservations(
  dataPath: string,
  filters: ObservationFilters,
) {
  const [state, setState] = useState<ObservationsState>({ status: "loading" });
  const { category, executionId, name, outcome } = filters;

  const load = useCallback(async (
    before?: number,
    replaceHistory = false,
  ) => {
    try {
      const url = new URL(`${dataPath}/observations`, window.location.origin);
      url.searchParams.set("limit", "50");

      for (const [key, value] of Object.entries({
        category,
        executionId,
        name,
        outcome,
      })) {
        if (value !== "") {
          url.searchParams.set(key, value);
        }
      }

      if (before !== undefined) {
        url.searchParams.set("before", String(before));
      }

      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Observations request failed with status ${response.status}.`);
      }

      const page = await response.json() as StudioObservationPage;

      setState((current) => ({
        status: "ready",
        items: before !== undefined && current.status === "ready"
          ? [...current.items, ...page.items]
          : !replaceHistory
            && current.status === "ready"
            && current.loadedOlder
            ? mergeNewestObservations(page.items, current.items)
            : page.items,
        loadedOlder: !replaceHistory
          && (before !== undefined
            || (current.status === "ready" && current.loadedOlder)),
        nextBefore: !replaceHistory
          && before === undefined
          && current.status === "ready"
          && current.loadedOlder
          ? current.nextBefore
          : page.nextBefore,
      }));
    } catch (error: unknown) {
      setState({
        status: "error",
        message: error instanceof Error
          ? error.message
          : "Unable to load observations.",
      });
    }
  }, [category, dataPath, executionId, name, outcome]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
    const interval = window.setInterval(() => void load(), 2_000);

    return () => window.clearInterval(interval);
  }, [load]);

  const clear = useCallback(async () => {
    const response = await fetch(`${dataPath}/observations`, {
      method: "DELETE",
    });

    if (!response.ok) {
      setState({
        status: "error",
        message: `Clearing observations failed with status ${response.status}.`,
      });
      return;
    }

    // Clearing must discard any older pages retained by live refresh.
    setState({ status: "loading" });
    await load(undefined, true);
  }, [dataPath, load]);
  const loadMore = useCallback(async () => {
    if (state.status === "ready" && state.nextBefore !== null) {
      await load(state.nextBefore);
    }
  }, [load, state]);

  return { ...state, clear, loadMore };
}

/** Preserves already loaded history while replacing the live newest page. */
function mergeNewestObservations(
  newest: readonly StudioObservation[],
  current: readonly StudioObservation[],
): readonly StudioObservation[] {
  const newestIds = new Set(newest.map((observation) => observation.id));

  return [
    ...newest,
    ...current.filter((observation) => !newestIds.has(observation.id)),
  ];
}

function ExecutionExplorer({ dataPath }: { dataPath: string }) {
  const resource = useExecutions(dataPath);
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    if (
      resource.status === "ready"
      && resource.items.length > 0
      && !resource.items.some((item) => item.executionId === selectedId)
    ) {
      setSelectedId(resource.items[0]?.executionId);
    }
  }, [resource, selectedId]);

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading observed executions…</p>;
  }

  if (resource.status === "error") {
    return <p className="error-panel">{resource.message}</p>;
  }

  return (
    <section className="observation-explorer" aria-label="Observed executions">
      <div className="observation-toolbar">
        <span>{resource.items.length} captured executions</span>
        <button onClick={() => void resource.clear()} type="button">
          <Icon name="delete" />
          Clear observations
        </button>
      </div>
      {resource.items.length === 0
        ? <p className="observations-empty">No executions have been observed yet.</p>
        : (
            <div className="observation-layout">
              <div className="execution-list">
                {resource.items.map((execution) => (
                  <ExecutionRow
                    execution={execution}
                    key={execution.executionId}
                    onSelect={() => setSelectedId(execution.executionId)}
                    selected={execution.executionId === selectedId}
                  />
                ))}
                {resource.nextBefore !== null && (
                  <button
                    className="load-executions-button"
                    onClick={() => void resource.loadMore()}
                    type="button"
                  >
                    <Icon name="executions" />
                    Load older executions
                  </button>
                )}
              </div>
              {selectedId === undefined
                ? null
                : <ExecutionDetails dataPath={dataPath} executionId={selectedId} />}
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

type ExecutionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: readonly StudioObservationExecution[];
      nextBefore: number | null;
    };

function useExecutions(dataPath: string) {
  const [state, setState] = useState<ExecutionsState>({ status: "loading" });

  const load = useCallback(async (before?: number) => {
    try {
      const url = new URL(`${dataPath}/executions`, window.location.origin);
      url.searchParams.set("limit", "50");

      if (before !== undefined) {
        url.searchParams.set("before", String(before));
      }

      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Executions request failed with status ${response.status}.`);
      }

      const page = await response.json() as StudioObservationExecutionPage;

      setState((current) => ({
        status: "ready",
        items: before === undefined || current.status !== "ready"
          ? page.items
          : [...current.items, ...page.items],
        nextBefore: page.nextBefore,
      }));
    } catch (error: unknown) {
      setState({
        status: "error",
        message: error instanceof Error
          ? error.message
          : "Unable to load observed executions.",
      });
    }
  }, [dataPath]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 2_000);

    return () => window.clearInterval(interval);
  }, [load]);

  const clear = useCallback(async () => {
    const response = await fetch(`${dataPath}/executions`, {
      method: "DELETE",
    });

    if (!response.ok) {
      setState({
        status: "error",
        message: `Clearing observations failed with status ${response.status}.`,
      });
      return;
    }

    await load();
  }, [dataPath, load]);
  const loadMore = useCallback(async () => {
    if (state.status === "ready" && state.nextBefore !== null) {
      await load(state.nextBefore);
    }
  }, [load, state]);

  return { ...state, clear, loadMore };
}
