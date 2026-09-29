import type { StudioLog } from "../contract.js";
import { getStudioWorkloadLabel } from "./workloads.js";

/** Renders one expandable structured log for full and execution-scoped lists. */
export function LogRow({ log }: { log: StudioLog }) {
  const level = getLevel(log.level);

  return (
    <details className="log-row">
      <summary>
        <time dateTime={log.loggedAt}>
          {new Date(log.loggedAt).toLocaleTimeString()}
        </time>
        <span className={`log-level ${level.className}`}>{level.label}</span>
        <span className="log-workload">
          {getStudioWorkloadLabel(log.workload)}
        </span>
        <span className="log-message">{log.message ?? "Structured event"}</span>
        <code>{log.requestId ?? "—"}</code>
      </summary>
      <pre>{JSON.stringify(log.payload, null, 2)}</pre>
    </details>
  );
}

function getLevel(level: number): { label: string; className: string } {
  const labels = new Map<number, string>([
    [10, "Trace"],
    [20, "Debug"],
    [30, "Info"],
    [40, "Warn"],
    [50, "Error"],
    [60, "Fatal"],
  ]);
  const label = labels.get(level) ?? String(level);

  return {
    label,
    className: label.toLowerCase(),
  };
}
