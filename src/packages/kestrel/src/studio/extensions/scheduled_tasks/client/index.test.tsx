// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStudioPageRenderer } from "../../../client/src/extensions.js";
import {
  SCHEDULED_TASKS_STUDIO_PAGE_KIND,
  type StudioScheduledTask,
  type StudioScheduledTaskCatalog,
} from "../contract.js";

const dataPath = "/studio/api/scheduled-tasks";
const now = new Date("2026-11-12T10:00:00.000Z");
const firstTask: StudioScheduledTask = {
  kind: "task", id: "exports.clean", description: "Delete expired exports.", groups: ["maintenance"],
  overlap: "skip", executionLog: true, observe: false, source: { kind: "provider", provider: "ExportProvider" },
  stateKind: "persistent", schedule: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" }, controllable: true,
  state: {
    paused: false, activeRuns: 1, nextScheduledAt: "2026-11-12T10:10:00.000Z", lastCompletedAt: now.toISOString(),
    lastOutcome: "failure", lastError: { name: "Error", message: "Could not clean exports" },
  },
};
const secondTask: StudioScheduledTask = {
  kind: "task", id: "exports.verify", groups: [], overlap: "wait", executionLog: false, observe: true,
  source: { kind: "application" }, stateKind: "persistent", controllable: true,
  schedule: { kind: "every", intervalMs: 60_000, start: now.toISOString() },
  state: {
    paused: true, activeRuns: 0, lastCompletedAt: "2026-11-10T10:00:00.000Z", lastOutcome: "success",
  },
};
const localTask: StudioScheduledTask = {
  kind: "task", id: "logs.inspect", groups: [], overlap: "parallel", executionLog: false, observe: false,
  source: { kind: "application" }, stateKind: "memory", controllable: false, unavailableReason: "Local only",
  schedule: { kind: "loop", delayMs: 125, start: now.toISOString() },
};

function catalog(...tasks: StudioScheduledTask[]): Response {
  return Response.json({
    nodes: [{ kind: "group", id: "maintenance", name: "Maintenance", children: tasks }],
  } satisfies StudioScheduledTaskCatalog);
}

describe("Studio scheduled-task interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  async function mount() {
    const renderer = await loadStudioPageRenderer(SCHEDULED_TASKS_STUDIO_PAGE_KIND);
    expect(renderer).toBeDefined();
    await act(async () => root.render(renderer!.render({
      id: "tasks", kind: SCHEDULED_TASKS_STUDIO_PAGE_KIND, title: "Scheduled tasks", path: "/tasks", dataPath,
    })));
  }

  function row(task: StudioScheduledTask): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>(".scheduled-task-row")]
      .find((element) => element.querySelector("strong")?.textContent === task.id);
    if (found === undefined) throw new Error(`Missing task: ${task.id}`);
    return found;
  }

  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
    if (found === undefined) throw new Error(`Missing button: ${label}`);
    return found;
  }

  it("retries catalog failure and shows operational state, run times, and available controls", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(catalog(firstTask, secondTask, localTask))
      .mockResolvedValueOnce(Response.json({ message: "Only an operator can run this task." }, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(catalog(firstTask, {
        ...secondTask, state: { paused: false, activeRuns: 0, manualRunRequestedAt: now.toISOString() },
      }, localTask));
    await mount();
    expect(container.textContent).toContain("Unable to load scheduled tasks (503).");
    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("Maintenance");
    expect(container.textContent).toContain("3 registered tasks");
    expect(row(firstTask).textContent).toContain("0 * * * * (UTC)");
    expect(row(firstTask).textContent).toContain("1 running");
    expect(row(firstTask).textContent).toContain("Could not clean exports");
    expect(row(firstTask).querySelector('[data-label="Next run"]')?.textContent).toContain("in 10 minutes");
    expect(row(secondTask).textContent).toContain("every 1m");
    expect(row(secondTask).textContent).toContain("2 days ago");
    expect(row(secondTask).textContent).toContain("Success");
    expect(row(secondTask).textContent).toContain("Paused");
    expect(row(localTask).textContent).toContain("loop 125ms");
    expect(row(localTask).textContent).toContain("Local");
    expect(button("Run now", row(localTask)).disabled).toBe(true);

    await act(async () => button("Run now", row(firstTask)).click());
    expect(container.textContent).toContain("Only an operator can run this task.");
    await act(async () => button("Resume", row(secondTask)).click());
    expect(request.mock.calls[3]).toEqual([`${dataPath}/control`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ taskId: secondTask.id, action: "resume" }),
    })]);
    expect(container.textContent).not.toContain("Only an operator");
    expect(row(secondTask).textContent).toContain("Run requested");
  });

  it("keeps each task disabled until its own control request settles", async () => {
    const pause = Promise.withResolvers<Response>();
    const run = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(catalog(firstTask, secondTask))
      .mockReturnValueOnce(pause.promise)
      .mockReturnValueOnce(run.promise)
      .mockResolvedValueOnce(catalog({
        ...firstTask, state: { paused: true, activeRuns: 0 },
      }, secondTask));
    await mount();

    await act(async () => button("Pause", row(firstTask)).click());
    expect(button("Run now", row(firstTask)).disabled).toBe(true);
    await act(async () => button("Run now", row(secondTask)).click());
    // Completing a different task must not unlock a still-pending mutation.
    expect(button("Run now", row(firstTask)).disabled).toBe(true);
    expect(button("Resume", row(secondTask)).disabled).toBe(true);
    await act(async () => run.resolve(new Response("Unavailable", { status: 502 })));
    expect(container.textContent).toContain("Unable to control the task (502).");
    expect(button("Resume", row(secondTask)).disabled).toBe(false);
    expect(button("Run now", row(firstTask)).disabled).toBe(true);
    await act(async () => pause.resolve(new Response(null, { status: 204 })));
    expect(button("Resume", row(firstTask)).disabled).toBe(false);
  });
});
