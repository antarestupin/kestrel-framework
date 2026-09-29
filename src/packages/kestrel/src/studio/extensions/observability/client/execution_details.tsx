import { useEffect, useRef, useState, type ReactNode } from "react";

import { LogRow } from "../../logs/client/log_row.js";
import type {
  StudioExecutionLogs,
  StudioObservation,
} from "../contract.js";
import {
  ExecutionTimeline,
  type ExecutionTimelineProperties,
} from "./timeline.js";
import { ExecutionGroup } from "./execution_group.js";
import { ObservationRow } from "./observation_row.js";
import {
  combineExecutionGroups,
  describeLogExecution,
  describeObservationExecution,
  type ExecutionDisplayMode,
} from "./execution_grouping.js";
import "../../logs/client/styles.css";

const LOG_POLL_INTERVAL_MS = 100;
const LOG_POLL_TIMEOUT_MS = 2_000;

/** Displays every execution artifact in a stable observations-then-logs order. */
export function ExecutionDetails(properties: ExecutionTimelineProperties) {
  const correlationKey = properties.contextKey;
  const [displayMode, setDisplayMode] = useState<ExecutionDisplayMode>(
    correlationKey === undefined ? "chronological" : "grouped",
  );

  const grouped = correlationKey !== undefined
    && displayMode === "grouped";

  return (
    <div className="execution-details">
      <ExecutionTimeline
        {...properties}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
        {...(!grouped || correlationKey === undefined
          ? {}
          : {
              renderItems: (observations: readonly StudioObservation[]) => (
                <CorrelatedExecutionGroups
                  contextKey={correlationKey}
                  dataPath={properties.dataPath}
                  executionId={properties.executionId}
                  observations={observations}
                  pollAfterRequest={properties.pollUntilCompleted ?? false}
                  requestPending={properties.requestPending ?? false}
                />
              ),
            })}
      />
      {!grouped && (
        <ExecutionLogs
          {...(properties.contextKey === undefined
            ? {}
            : { contextKey: properties.contextKey })}
          dataPath={properties.dataPath}
          executionId={properties.executionId}
          pollAfterRequest={properties.pollUntilCompleted ?? false}
          requestPending={properties.requestPending ?? false}
        />
      )}
    </div>
  );
}

interface ExecutionLogsProperties {
  contextKey?: string;
  dataPath: string;
  executionId: string;
  /** Keeps loading during a Studio request and briefly after it completes. */
  pollAfterRequest?: boolean;
  requestPending?: boolean;
}

/** Renders structured logs correlated through their execution identifier. */
function ExecutionLogs({
  contextKey,
  dataPath,
  executionId,
  pollAfterRequest = false,
  requestPending = false,
}: ExecutionLogsProperties) {
  const resource = useExecutionLogs(
    dataPath,
    executionId,
    contextKey,
    pollAfterRequest,
    requestPending,
  );

  return (
    <section className="execution-logs" aria-label="Execution logs">
      <header>Execution logs</header>
      {resource.status === "loading" && (
        <p className="execution-logs-message">Loading logs…</p>
      )}
      {resource.status === "error" && (
        <p className="execution-logs-message error">{resource.message}</p>
      )}
      {resource.status === "ready" && resource.items.length === 0 && (
        <p className="execution-logs-message">
          {resource.polling
            ? "Waiting for logs…"
            : "No logs were captured."}
        </p>
      )}
      {resource.status === "ready" && resource.items.map((log) => (
        <LogRow key={log.id} log={log} />
      ))}
    </section>
  );
}

/** Places observations and logs from each correlated scope next to each other. */
function CorrelatedExecutionGroups({
  contextKey,
  dataPath,
  executionId,
  observations,
  pollAfterRequest,
  requestPending,
}: {
  contextKey: string;
  dataPath: string;
  executionId: string;
  observations: readonly StudioObservation[];
  pollAfterRequest: boolean;
  requestPending: boolean;
}) {
  const logsResource = useExecutionLogs(
    dataPath,
    executionId,
    contextKey,
    pollAfterRequest,
    requestPending,
  );
  const groups = combineExecutionGroups(
    observations,
    logsResource.status === "ready" ? logsResource.items : [],
  );
  const [observationsOpen, setObservationsOpen] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [observationsOpenByDefault, setObservationsOpenByDefault] =
    useState(true);
  const [logsOpen, setLogsOpen] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [logsOpenByDefault, setLogsOpenByDefault] = useState(true);
  const executionIds = groups.map((group) => group.executionId);
  const setAllObservationsVisibility = (open: boolean): void => {
    setObservationsOpenByDefault(open);
    setObservationsOpen(setAllOpen(executionIds, open));
  };
  const setAllLogsVisibility = (open: boolean): void => {
    setLogsOpenByDefault(open);
    setLogsOpen(setAllOpen(executionIds, open));
  };

  if (groups.length === 0 && logsResource.status === "loading") {
    return <p className="timeline-message">Loading correlated artifacts…</p>;
  }

  if (groups.length === 0 && logsResource.status === "error") {
    return <p className="timeline-message error">{logsResource.message}</p>;
  }

  if (groups.length === 0) {
    return <p className="timeline-message">No correlated artifacts were captured.</p>;
  }

  return (
    <div className="correlated-execution-artifacts">
      <div className="execution-group-toolbar">
        <ArtifactVisibilityControls
          collapseAll={() => setAllObservationsVisibility(false)}
          expandAll={() => setAllObservationsVisibility(true)}
          label="Observations"
        />
        <ArtifactVisibilityControls
          collapseAll={() => setAllLogsVisibility(false)}
          expandAll={() => setAllLogsVisibility(true)}
          label="Logs"
        />
      </div>
      {logsResource.status === "error" && (
        <p className="execution-correlated-message error">
          {logsResource.message}
        </p>
      )}
      <div className="execution-groups">
        {groups.map((group) => {
          const presentation = group.observations.length > 0
            ? describeObservationExecution(group.observations)
            : describeLogExecution(group.logs);

          return (
            <ExecutionGroup
              count={group.observations.length + group.logs.length}
              executionId={group.executionId}
              itemLabel="artifact"
              key={group.executionId}
              presentation={presentation}
            >
              <ArtifactSection
                count={group.observations.length}
                label="Observations"
                onOpenChange={(open) => setObservationsOpen((current) => ({
                  ...current,
                  [group.executionId]: open,
                }))}
                open={observationsOpen[group.executionId]
                  ?? observationsOpenByDefault}
              >
                {group.observations.length === 0
                  ? <p className="execution-artifact-message">No observations.</p>
                  : group.observations.map((event) => (
                      <ObservationRow event={event} key={event.id} />
                    ))}
              </ArtifactSection>
              <ArtifactSection
                count={group.logs.length}
                label="Logs"
                onOpenChange={(open) => setLogsOpen((current) => ({
                  ...current,
                  [group.executionId]: open,
                }))}
                open={logsOpen[group.executionId] ?? logsOpenByDefault}
              >
                {logsResource.status === "loading"
                  ? <p className="execution-artifact-message">Loading logs…</p>
                  : group.logs.length === 0
                    ? <p className="execution-artifact-message">No logs.</p>
                    : group.logs.map((log) => <LogRow key={log.id} log={log} />)}
              </ArtifactSection>
            </ExecutionGroup>
          );
        })}
      </div>
    </div>
  );
}

/** Controls every section of one artifact type without affecting group state. */
function ArtifactVisibilityControls({
  collapseAll,
  expandAll,
  label,
}: {
  collapseAll: () => void;
  expandAll: () => void;
  label: string;
}) {
  return (
    <span className="artifact-visibility-controls">
      <span>{label}</span>
      <button onClick={expandAll} type="button">Expand all</button>
      <button onClick={collapseAll} type="button">Collapse all</button>
    </span>
  );
}

/** Keeps native details interaction synchronized with global visibility actions. */
function ArtifactSection({
  children,
  count,
  label,
  onOpenChange,
  open,
}: {
  children: ReactNode;
  count: number;
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <details
      className="execution-artifact-section"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <strong>{label}</strong>
        <span>{count}</span>
      </summary>
      <div className="execution-artifact-section-items">{children}</div>
    </details>
  );
}

function setAllOpen(
  executionIds: readonly string[],
  open: boolean,
): Readonly<Record<string, boolean>> {
  return Object.fromEntries(executionIds.map((id) => [id, open]));
}

type ExecutionLogsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: StudioExecutionLogs["items"];
      polling: boolean;
    };

/** Loads once for existing executions and polls around interactive requests. */
function useExecutionLogs(
  dataPath: string,
  executionId: string,
  contextKey: string | undefined,
  pollAfterRequest: boolean,
  requestPending: boolean,
): ExecutionLogsState {
  const [state, setState] = useState<ExecutionLogsState>({ status: "loading" });
  const requestPendingRef = useRef(requestPending);
  const requestFinishedAtRef = useRef(performance.now());

  useEffect(() => {
    requestPendingRef.current = requestPending;

    if (!requestPending) {
      requestFinishedAtRef.current = performance.now();
    }
  }, [requestPending]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;

    const load = async (): Promise<void> => {
      try {
        const url = new URL(`${dataPath}/logs`, window.location.origin);
        url.searchParams.set("executionId", executionId);
        if (contextKey !== undefined) {
          url.searchParams.set("contextKey", contextKey);
        }
        const response = await fetch(url, {
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Execution logs request failed with status ${response.status}.`);
        }

        const logs = await response.json() as StudioExecutionLogs;

        if (cancelled) {
          return;
        }

        const timedOut = performance.now() - requestFinishedAtRef.current
          >= LOG_POLL_TIMEOUT_MS;
        const shouldPoll = pollAfterRequest
          && (requestPendingRef.current || !timedOut);

        setState({
          status: "ready",
          items: logs.items,
          polling: shouldPoll,
        });

        if (shouldPoll) {
          pollTimer = window.setTimeout(
            () => void load(),
            LOG_POLL_INTERVAL_MS,
          );
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error
              ? error.message
              : "Unable to load execution logs.",
          });
        }
      }
    };

    setState({ status: "loading" });
    void load();

    return () => {
      cancelled = true;

      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [contextKey, dataPath, executionId, pollAfterRequest]);

  return state;
}
