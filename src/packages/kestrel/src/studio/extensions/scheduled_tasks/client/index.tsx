import { type CSSProperties, useCallback, useEffect, useState } from "react";

import { Icon } from "../../../client/src/ui/icon.js";
import type { StudioPageManifest } from "../../../extension.js";
import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import {
  type StudioScheduledTask,
  type StudioScheduledTaskCatalog,
  type StudioScheduledTaskCatalogNode,
  type StudioScheduledTaskControlAction,
  SCHEDULED_TASKS_STUDIO_PAGE_KIND,
} from "../contract.js";
import "./styles.css";

type CatalogResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: StudioScheduledTaskCatalog };

interface CatalogRow {
  node: StudioScheduledTaskCatalogNode;
  depth: number;
}

const scheduledTasksStudioPageRenderer: StudioPageRenderer = {
  kind: SCHEDULED_TASKS_STUDIO_PAGE_KIND,
  render: (page) => <ScheduledTasksStudioPage page={page} />,
};

addStudioPageRenderer(scheduledTasksStudioPageRenderer);

function ScheduledTasksStudioPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page scheduled-tasks-page">
      <StudioPageHeader page={page} eyebrow="Operations" />
      {page.dataPath === undefined
        ? <p className="error-panel">The scheduled-tasks page has no data endpoint.</p>
        : <ScheduledTaskWorkspace dataPath={page.dataPath} />}
    </div>
  );
}

function ScheduledTaskWorkspace({ dataPath }: { dataPath: string }) {
  const [resource, setResource] = useState<CatalogResource>({ status: "loading" });
  const [updatingTask, setUpdatingTask] = useState<string>();
  const [controlError, setControlError] = useState<string>();
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${dataPath}/catalog`);

      if (!response.ok) {
        throw new Error(`Unable to load scheduled tasks (${response.status}).`);
      }

      setResource({
        status: "ready",
        catalog: await response.json() as StudioScheduledTaskCatalog,
      });
    } catch (error) {
      setResource({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dataPath]);

  useEffect(() => {
    void load();

    // Refresh operational state at the same cadence as logs and observations.
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    // Keep relative run times useful without reloading scheduler state.
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const control = async (
    task: StudioScheduledTask,
    action: StudioScheduledTaskControlAction,
  ) => {
    setUpdatingTask(task.id);
    setControlError(undefined);

    try {
      const response = await fetch(`${dataPath}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, action }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as
          | { message?: string }
          | undefined;
        throw new Error(body?.message ?? `Unable to control the task (${response.status}).`);
      }

      await load();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingTask(undefined);
    }
  };

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading scheduled tasks…</p>;
  }

  if (resource.status === "error") {
    return (
      <div className="scheduled-task-error error-panel">
        <span>{resource.message}</span>
        <button onClick={() => void load()} type="button">
          <Icon name="retry" /> Retry
        </button>
      </div>
    );
  }

  const rows = flattenRows(resource.catalog.nodes);
  const taskCount = rows.filter(({ node }) => node.kind === "task").length;

  return (
    <section className="scheduled-task-catalog" aria-label="Scheduled tasks">
      <header className="scheduled-task-summary">
        <span>{taskCount} registered tasks</span>
        <button onClick={() => void load()} type="button">
          <Icon name="refresh" /> Refresh
        </button>
      </header>
      {controlError !== undefined && (
        <p className="scheduled-task-control-error">{controlError}</p>
      )}
      <div className="scheduled-task-table" role="table">
        <div className="scheduled-task-row heading" role="row">
          <span>Task</span>
          <span>Schedule</span>
          <span>Last run</span>
          <span>Next run</span>
          <span>Status</span>
          <span>Controls</span>
        </div>
        {rows.map(({ node, depth }) => node.kind === "group"
          ? (
              <div
                className="scheduled-task-group-row"
                key={node.id}
                role="row"
                style={{ "--scheduled-task-depth": depth } as CSSProperties}
              >
                {node.name}
              </div>
            )
          : (
              <ScheduledTaskRow
                depth={depth}
                key={node.id}
                now={currentTime}
                onControl={control}
                task={node}
                updating={updatingTask === node.id}
              />
            ))}
      </div>
    </section>
  );
}

function ScheduledTaskRow({
  depth,
  now,
  onControl,
  task,
  updating,
}: {
  depth: number;
  now: number;
  onControl: (
    task: StudioScheduledTask,
    action: StudioScheduledTaskControlAction,
  ) => Promise<void>;
  task: StudioScheduledTask;
  updating: boolean;
}) {
  const paused = task.state?.paused === true;
  const status = task.state === undefined
    ? task.stateKind === "memory" ? "Local" : "Pending"
    : paused ? "Paused"
    : task.state.activeRuns > 0 ? `${task.state.activeRuns} running`
    : task.state.manualRunRequestedAt !== undefined ? "Run requested"
    : "Active";

  return (
    <div className="scheduled-task-row" role="row">
      <div
        className="scheduled-task-identity"
        style={{ "--scheduled-task-depth": depth } as CSSProperties}
      >
        <strong>{task.id}</strong>
        {task.description !== undefined && <small>{task.description}</small>}
        <span>
          {formatSource(task)} · {task.overlap} overlap
          {task.executionLog ? " · execution log" : " · no execution log"}
          {task.observe ? " · observations" : " · no observations"}
          {task.groups.length > 0 ? ` · ${task.groups.join(", ")}` : ""}
        </span>
      </div>
      <code className="scheduled-task-schedule" data-label="Schedule">
        {formatSchedule(task)}
      </code>
      <RunTime
        error={task.state?.lastError?.message}
        label="Last run"
        now={now}
        outcome={task.state?.lastOutcome}
        position="last"
        value={task.state?.lastCompletedAt}
      />
      <RunTime
        label="Next run"
        now={now}
        position="next"
        value={task.state?.nextScheduledAt}
      />
      <span className={`scheduled-task-status ${status.toLowerCase().replace(" ", "-")}`}>
        {status}
      </span>
      <div className="scheduled-task-controls" title={task.unavailableReason}>
        <button
          disabled={!task.controllable || updating}
          onClick={() => void onControl(task, "run")}
          type="button"
        >
          <Icon name={updating ? "loading" : "play"} spin={updating} /> Run now
        </button>
        <button
          disabled={!task.controllable || updating}
          onClick={() => void onControl(task, paused ? "resume" : "pause")}
          type="button"
        >
          <Icon name={paused ? "play" : "pause"} /> {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </div>
  );
}

function flattenRows(
  nodes: readonly StudioScheduledTaskCatalogNode[],
  depth = 0,
): readonly CatalogRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "group" ? flattenRows(node.children, depth + 1) : []),
  ]);
}

function formatSource(task: StudioScheduledTask): string {
  return task.source.kind === "application"
    ? "Application"
    : task.source.provider;
}

function formatSchedule(task: StudioScheduledTask): string {
  if (task.schedule.kind === "cron") {
    return `${task.schedule.expression}${task.schedule.timeZone === undefined ? "" : ` (${task.schedule.timeZone})`}`;
  }

  const milliseconds = task.schedule.kind === "every"
    ? task.schedule.intervalMs
    : task.schedule.delayMs;
  return `${task.schedule.kind} ${formatDuration(milliseconds)}`;
}

function formatDuration(milliseconds: number): string {
  const units = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ] as const;
  const unit = units.find(([size]) => milliseconds % size === 0);
  return unit === undefined ? `${milliseconds}ms` : `${milliseconds / unit[0]}${unit[1]}`;
}

function formatDate(value?: string): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function RunTime({
  error,
  label,
  now,
  outcome,
  position,
  value,
}: {
  error?: string | undefined;
  label: string;
  now: number;
  outcome?: "failure" | "success" | undefined;
  position: "last" | "next";
  value?: string | undefined;
}) {
  if (value === undefined) {
    return (
      <span className={`scheduled-task-time ${position}`} data-label={label}>
        —
      </span>
    );
  }

  return (
    <div
      className={`scheduled-task-time ${position} ${outcome === "failure" ? "failed" : ""}`}
      data-label={label}
    >
      <span>{formatDate(value)}</span>
      <small>{formatRelativeDate(value, now)}</small>
      {outcome !== undefined && (
        <small>{outcome === "failure" ? error ?? "Failed" : "Success"}</small>
      )}
    </div>
  );
}

function formatRelativeDate(value: string, now: number): string {
  const differenceMs = new Date(value).getTime() - now;
  const absoluteDifference = Math.abs(differenceMs);

  if (absoluteDifference < 500) {
    return "now";
  }

  const units = absoluteDifference < 90_000
    ? [1_000, "second"] as const
    : absoluteDifference < 5_400_000
      ? [60_000, "minute"] as const
      : absoluteDifference < 129_600_000
        ? [3_600_000, "hour"] as const
        : [86_400_000, "day"] as const;
  const amount = Math.round(differenceMs / units[0]);

  return new Intl.RelativeTimeFormat("en", { numeric: "always" }).format(
    amount,
    units[1],
  );
}
