import {
  useCallback,
  useEffect,
  useState,
} from "react";

import type {
  StudioLog,
  StudioLogPage,
} from "../contract.js";
import { DEV_LOGS_PAGE_KIND } from "../contract.js";
import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import { Icon } from "../../../client/src/ui/icon.js";
import { LogRow } from "./log_row.js";
import {
  studioWorkloadOptions,
  type StudioWorkloadFilter,
} from "./workloads.js";
import "./styles.css";

const LEVELS = [
  { value: "", label: "All" },
  { value: "10", label: "Trace" },
  { value: "20", label: "Debug" },
  { value: "30", label: "Info" },
  { value: "40", label: "Warn" },
  { value: "50", label: "Error" },
  { value: "60", label: "Fatal" },
] as const;

const developmentLogsPageRenderer: StudioPageRenderer = {
  kind: DEV_LOGS_PAGE_KIND,
  render: (page) => <DevelopmentLogsPage page={page} />,
};

addStudioPageRenderer(developmentLogsPageRenderer);

function DevelopmentLogsPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Observability" />
      {page.dataPath === undefined
        ? <p className="error-panel">The logs page has no data endpoint.</p>
        : <LogsExplorer dataPath={page.dataPath} />}
    </div>
  );
}

function LogsExplorer({ dataPath }: { dataPath: string }) {
  const [level, setLevel] = useState("");
  const [workload, setWorkload] = useState<StudioWorkloadFilter>("");
  const resource = useLogs(dataPath, level, workload);

  return (
    <section className="logs-explorer" aria-label="Development logs">
      <div className="logs-toolbar">
        <div className="log-filters">
          <div className="log-filter-group">
            <span>Level</span>
            <div className="log-filter-options" aria-label="Filter by level">
              {LEVELS.map((option) => (
                <button
                  className={level === option.value ? "active" : ""}
                  key={option.value}
                  onClick={() => setLevel(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="log-filter-group">
            <span>Workload</span>
            <div className="log-filter-options" aria-label="Filter by workload">
              {studioWorkloadOptions.map((option) => (
                <button
                  className={workload === option.value ? "active" : ""}
                  key={option.value}
                  onClick={() => setWorkload(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          className="clear-logs-button"
          onClick={() => void resource.clear()}
          type="button"
        >
          <Icon name="delete" />
          Clear logs
        </button>
      </div>

      {resource.status === "loading" && (
        <p className="loading-panel">Loading structured logs…</p>
      )}
      {resource.status === "error" && (
        <p className="error-panel">{resource.message}</p>
      )}
      {resource.status === "ready" && (
        <>
          <div className="logs-list">
            {resource.items.length === 0
              ? <p className="logs-empty">No logs match this filter.</p>
              : resource.items.map((log) => (
                  <LogRow key={log.id} log={log} />
                ))}
          </div>
          {resource.nextBefore !== null && (
            <button
              className="load-logs-button"
              onClick={() => void resource.loadMore()}
              type="button"
            >
              <Icon name="executions" />
              Load older logs
            </button>
          )}
        </>
      )}
    </section>
  );
}

type LogsResource =
  | { status: "loading"; clear(): Promise<void>; loadMore(): Promise<void> }
  | { status: "error"; message: string; clear(): Promise<void>; loadMore(): Promise<void> }
  | {
      status: "ready";
      items: readonly StudioLog[];
      nextBefore: number | null;
      clear(): Promise<void>;
      loadMore(): Promise<void>;
    };

function useLogs(
  dataPath: string,
  level: string,
  workload: StudioWorkloadFilter,
): LogsResource {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; items: readonly StudioLog[]; nextBefore: number | null }
  >({ status: "loading" });

  const load = useCallback(async (before?: number) => {
    try {
      const url = new URL(dataPath, window.location.origin);
      url.searchParams.set("limit", "50");

      if (level !== "") {
        url.searchParams.set("level", level);
      }

      if (workload !== "") {
        url.searchParams.set("workload", workload);
      }

      if (before !== undefined) {
        url.searchParams.set("before", String(before));
      }

      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Logs request failed with status ${response.status}.`);
      }

      const page = await response.json() as StudioLogPage;

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
          : "Unable to load logs.",
      });
    }
  }, [dataPath, level, workload]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();

    // Keep the newest page live without requiring a manual refresh.
    const interval = window.setInterval(() => void load(), 2_000);

    return () => window.clearInterval(interval);
  }, [load]);

  const clear = useCallback(async () => {
    const response = await fetch(dataPath, { method: "DELETE" });

    if (!response.ok) {
      setState({
        status: "error",
        message: `Clearing logs failed with status ${response.status}.`,
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
