import { Link } from "@tanstack/react-router";

import {
  getStudioObservationExecutionPath,
  type StudioObservation,
} from "../contract.js";
import { ObservationContent } from "./observation_content.js";
import { formatObservationDuration } from "./observation_format.js";

/** Renders one expandable observation, optionally with its execution link. */
export function ObservationRow({
  event,
  showDate = false,
  showExecutionLink = false,
}: {
  event: StudioObservation;
  showDate?: boolean;
  showExecutionLink?: boolean;
}) {
  return (
    <details className="observation-row" open={event.outcome === "failure"}>
      <summary>
        <time dateTime={event.occurredAt}>
          {showDate
            ? new Date(event.occurredAt).toLocaleString()
            : new Date(event.occurredAt).toLocaleTimeString()}
        </time>
        <span className="observation-category">{event.category}</span>
        <strong>{event.name}</strong>
        <span className={`observation-outcome ${event.outcome ?? "unset"}`}>
          {event.outcome ?? "not set"}
        </span>
        <span>{formatObservationDuration(event.durationMs)}</span>
      </summary>
      {showExecutionLink && (
        <div className="observation-execution-link">
          <span>Execution</span>
          <Link to={getStudioObservationExecutionPath(event.executionId)}>
            {event.executionId}
          </Link>
        </div>
      )}
      <ObservationContent event={event} />
    </details>
  );
}
