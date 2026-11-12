import {
  useCallback,
  useEffect,
  useRef,
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
        : <LogsExplorer key={page.dataPath} dataPath={page.dataPath} />}
    </div>
  );
}

function LogsExplorer({ dataPath }: { dataPath: string }) {
  const [level, setLevel] = useState("");
  const [workload, setWorkload] = useState<StudioWorkloadFilter>("");
  const resource = useLogs(dataPath, level, workload);
  const nextBefore = resource.status === "ready" ? resource.nextBefore : null;

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
          {nextBefore !== null && (
            <button
              className="load-logs-button"
              onClick={() => void resource.loadMore(nextBefore)}
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

type LogsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: readonly StudioLog[];
      loadedOlder: boolean;
      nextBefore: number | null;
    };

type LogsResource = LogsState & {
  clear(): Promise<void>;
  loadMore(before: number): Promise<void>;
};

function useLogs(
  dataPath: string,
  level: string,
  workload: StudioWorkloadFilter,
): LogsResource {
  const [state, setState] = useState<LogsState>({ status: "loading" });
  const activeFilter = useRef<{
    controller: AbortController;
    load: (signal: AbortSignal, before?: number) => Promise<void>;
  } | undefined>(undefined);
  const activeRead = useRef<AbortController | undefined>(undefined);
  const clearing = useRef(false);

  const load = useCallback(async (scope: AbortSignal, before?: number) => {
    activeRead.current?.abort();
    const request = new AbortController();
    activeRead.current = request;
    const signal = AbortSignal.any([scope, request.signal]);
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
        signal,
      });

      if (!response.ok) {
        throw new Error(`Logs request failed with status ${response.status}.`);
      }

      const page = await response.json() as StudioLogPage;
      if (signal.aborted) return;

      setState((current) => {
        if (current.status === "ready") {
          if (before !== undefined) {
            return {
              status: "ready", items: mergeLogEntries(current.items, page.items),
              loadedOlder: true, nextBefore: page.nextBefore,
            };
          }
          // Refresh the newest entries without replacing the loaded pagination.
          if (current.loadedOlder) {
            return { ...current, items: mergeLogEntries(page.items, current.items) };
          }
        }
        return { status: "ready", items: page.items, loadedOlder: false, nextBefore: page.nextBefore };
      });
    } catch (error: unknown) {
      if (signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error
          ? error.message
          : "Unable to load logs.",
      });
    } finally {
      if (activeRead.current === request) activeRead.current = undefined;
    }
  }, [dataPath, level, workload]);

  useEffect(() => {
    // A filter change invalidates every read started for the old filter.
    const controller = new AbortController();
    activeFilter.current = { controller, load };
    setState({ status: "loading" });
    void load(controller.signal);

    // Keep the newest page live without requiring a manual refresh.
    const interval = window.setInterval(() => {
      if (!clearing.current && activeRead.current === undefined) void load(controller.signal);
    }, 2_000);

    return () => {
      activeFilter.current = undefined;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [load]);

  const clear = useCallback(async () => {
    const filter = activeFilter.current;
    if (filter === undefined || clearing.current) return;
    clearing.current = true;
    // A read started before deletion must not restore the deleted messages.
    activeRead.current?.abort();
    try {
      // Clearing applies to the full log, independently of the selected filter.
      const response = await fetch(dataPath, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Clearing logs failed with status ${response.status}.`);
      }
      const current = activeFilter.current;
      // The filter can change while the full log is being cleared.
      if (current !== undefined) {
        setState({ status: "loading" });
        await current.load(current.controller.signal);
      }
    } catch (error: unknown) {
      if (filter.controller.signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Unable to clear logs.",
      });
    } finally {
      clearing.current = false;
    }
  }, [dataPath]);
  const loadMore = useCallback(async (before: number) => {
    const signal = activeFilter.current?.controller.signal;
    if (signal !== undefined && !clearing.current) await load(signal, before);
  }, [load]);

  return { ...state, clear, loadMore };
}

function mergeLogEntries(first: readonly StudioLog[], rest: readonly StudioLog[]): StudioLog[] {
  const seen = new Set(first.map((log) => log.id));
  return [...first, ...rest.filter((log) => !seen.has(log.id))];
}
