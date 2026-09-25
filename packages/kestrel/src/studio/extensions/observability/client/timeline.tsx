import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { executionCompletedObservation } from "../../../../app/observations.js";
import {
  getStudioObservationCorrelationPath,
  getStudioObservationExecutionPath,
  type StudioObservation,
  type StudioObservationTimeline,
} from "../contract.js";
import { ObservationRow } from "./observation_row.js";
import type { ExecutionDisplayMode } from "./execution_grouping.js";
import "./styles.css";

const TIMELINE_POLL_INTERVAL_MS = 100;
const TIMELINE_POLL_TIMEOUT_MS = 2_000;

export interface ExecutionTimelineProperties {
  contextKey?: string;
  dataPath: string;
  executionId: string;
  /** Polls briefly until buffered observations include execution completion. */
  pollUntilCompleted?: boolean;
  /** Limits post-request polling; null keeps polling until completion. */
  pollTimeoutMs?: number | null;
  /** Keeps polling without the post-response timeout while work is running. */
  requestPending?: boolean;
}

interface ExecutionTimelineViewProperties {
  displayMode?: ExecutionDisplayMode;
  onDisplayModeChange?: (mode: ExecutionDisplayMode) => void;
  renderItems?: (items: readonly StudioObservation[]) => ReactNode;
}

/** Displays the generic event timeline shared by observability-aware tools. */
export function ExecutionTimeline({
  contextKey,
  dataPath,
  displayMode = "chronological",
  executionId,
  onDisplayModeChange,
  pollUntilCompleted = false,
  pollTimeoutMs = TIMELINE_POLL_TIMEOUT_MS,
  requestPending = false,
  renderItems,
}: ExecutionTimelineProperties & ExecutionTimelineViewProperties) {
  const resource = useTimeline(
    dataPath,
    executionId,
    contextKey,
    pollUntilCompleted,
    pollTimeoutMs,
    requestPending,
  );

  return (
    <div className="execution-timeline">
      <header>
        <span>Execution timeline</span>
        <span className="execution-timeline-links">
          {contextKey !== undefined && onDisplayModeChange !== undefined && (
            <span className="execution-view-switch" aria-label="Timeline display">
              <button
                aria-pressed={displayMode === "grouped"}
                className={displayMode === "grouped" ? "active" : undefined}
                onClick={() => onDisplayModeChange("grouped")}
                type="button"
              >
                Grouped
              </button>
              <button
                aria-pressed={displayMode === "chronological"}
                className={displayMode === "chronological" ? "active" : undefined}
                onClick={() => onDisplayModeChange("chronological")}
                type="button"
              >
                Chronological
              </button>
            </span>
          )}
          <code>{executionId}</code>
          <Link to={contextKey === undefined
            ? getStudioObservationExecutionPath(executionId)
            : getStudioObservationCorrelationPath(contextKey, executionId)}>
            Permalink
          </Link>
        </span>
      </header>
      {resource.status === "loading" && (
        <p className="timeline-message">Loading observations…</p>
      )}
      {resource.status === "error" && (
        <p className="timeline-message error">{resource.message}</p>
      )}
      {resource.status === "ready"
        && resource.items.length === 0
        && renderItems === undefined && (
        <p className="timeline-message">
          {resource.polling
            ? "Waiting for observations…"
            : "No observations were captured."}
        </p>
      )}
      {resource.status === "ready" && (
        renderItems === undefined
          ? resource.items.map((event) => (
              <ObservationRow event={event} key={event.id} />
            ))
          : renderItems(resource.items)
      )}
    </div>
  );
}

type TimelineState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      items: readonly StudioObservation[];
      polling: boolean;
    };

function useTimeline(
  dataPath: string,
  executionId: string,
  contextKey: string | undefined,
  pollUntilCompleted: boolean,
  pollTimeoutMs: number | null,
  requestPending: boolean,
): TimelineState {
  const [state, setState] = useState<TimelineState>({ status: "loading" });
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
        const url = new URL(`${dataPath}/events`, window.location.origin);
        url.searchParams.set("executionId", executionId);
        if (contextKey !== undefined) {
          url.searchParams.set("contextKey", contextKey);
        }
        const response = await fetch(url, {
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Timeline request failed with status ${response.status}.`);
        }

        const timeline = await response.json() as StudioObservationTimeline;

        if (cancelled) {
          return;
        }

        const completed = timeline.items.some((event) =>
          event.name === executionCompletedObservation.name);
        const timedOut = pollTimeoutMs !== null
          && performance.now() - requestFinishedAtRef.current >= pollTimeoutMs;
        const shouldPoll = pollUntilCompleted
          && !completed
          && (requestPendingRef.current || !timedOut);

        setState({
          status: "ready",
          items: timeline.items,
          polling: shouldPoll,
        });

        if (shouldPoll) {
          pollTimer = window.setTimeout(
            () => void load(),
            TIMELINE_POLL_INTERVAL_MS,
          );
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error
              ? error.message
              : "Unable to load the execution timeline.",
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
  }, [contextKey, dataPath, executionId, pollTimeoutMs, pollUntilCompleted]);

  return state;
}
