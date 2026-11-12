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
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
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

  async function mount(endpoint: `/${string}` | null = dataPath) {
    const renderer = await loadStudioPageRenderer(SCHEDULED_TASKS_STUDIO_PAGE_KIND);
    expect(renderer).toBeDefined();
    await act(async () => root.render(renderer!.render({
      id: "tasks", kind: SCHEDULED_TASKS_STUDIO_PAGE_KIND, title: "Scheduled tasks", path: "/tasks",
      ...(endpoint === null ? {} : { dataPath: endpoint }),
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
    expect(request.mock.calls[0]?.[0]).toBe(`${dataPath}/catalog`);
    expect(container.textContent).toContain("Unable to load scheduled tasks (503).");
    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("Maintenance");
    expect(container.textContent).toContain("3 registered tasks");
    expect(row(firstTask).textContent).toContain("0 * * * * (UTC)");
    expect(row(firstTask).querySelector(".scheduled-task-status")?.classList.contains("1-running")).toBe(true);
    expect(row(firstTask).querySelector(".scheduled-task-identity small")?.textContent).toBe(firstTask.description);
    expect(row(firstTask).querySelector(".scheduled-task-identity span")?.textContent).toBe(
      "ExportProvider · skip overlap · execution log · no observations · maintenance",
    );
    expect(row(firstTask).querySelector(".scheduled-task-identity")?.getAttribute("style")).toContain("--scheduled-task-depth: 1");
    expect(row(firstTask).querySelector(".scheduled-task-time.last.failed span")?.textContent).toBe(now.toLocaleString());
    expect(row(firstTask).querySelector(".scheduled-task-time.last.failed small")?.textContent).toBe("now");
    expect(row(firstTask).textContent).toContain("Could not clean exports");
    expect(row(firstTask).querySelector('[data-label="Next run"]')?.textContent).toContain("in 10 minutes");
    expect(row(secondTask).textContent).toContain("every 1m");
    expect(row(secondTask).textContent).toContain("2 days ago");
    expect(row(secondTask).textContent).toContain("Success");
    expect(row(secondTask).textContent).toContain("Paused");
    expect(row(secondTask).querySelector(".scheduled-task-identity small")).toBeNull();
    expect(row(secondTask).querySelector(".scheduled-task-identity span")?.textContent).toBe(
      "Application · wait overlap · no execution log · observations",
    );
    expect(row(secondTask).querySelector(".scheduled-task-time.next")?.textContent?.trim()).toBe("—");
    expect(row(secondTask).querySelector(".scheduled-task-time.last")?.classList.contains("failed")).toBe(false);
    expect(button("Run now", row(secondTask)).querySelector("svg")).not.toBeNull();
    expect(button("Resume", row(secondTask)).querySelector("svg")).not.toBeNull();
    expect(button("Pause", row(firstTask)).querySelector("svg")).not.toBeNull();
    expect(row(localTask).textContent).toContain("loop 125ms");
    expect(row(localTask).textContent).toContain("Local");
    expect(row(localTask).querySelector(".scheduled-task-controls")?.getAttribute("title")).toBe("Local only");
    expect(button("Run now", row(localTask)).disabled).toBe(true);
    expect(container.querySelector(".scheduled-task-control-error")).toBeNull();

    await act(async () => button("Run now", row(firstTask)).click());
    expect(request.mock.calls[2]).toEqual([`${dataPath}/control`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: firstTask.id, action: "run" }),
    }]);
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

    await act(async () => {
      const pauseControl = button("Pause", row(firstTask));
      pauseControl.click();
      pauseControl.click();
    });
    expect(request.mock.calls.filter(([url]) => url === `${dataPath}/control`)).toHaveLength(1);
    expect(button("Run now", row(firstTask)).disabled).toBe(true);
    expect(button("Run now", row(firstTask)).querySelector("svg.spinning")).not.toBeNull();
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

  it("keeps the updated schedule when an earlier catalog poll finishes late", async () => {
    const stale = Promise.withResolvers<Response>();
    const paused = { ...firstTask, state: { ...firstTask.state!, paused: true } };
    request.mockResolvedValueOnce(catalog(firstTask))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(catalog(paused));
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(2);
    const signal = request.mock.calls[1]?.[1]?.signal;

    await act(async () => button("Pause", row(firstTask)).click());
    expect(row(firstTask).querySelector(".scheduled-task-status")?.textContent).toContain("Paused");
    await act(async () => stale.resolve(catalog(firstTask)));
    expect(row(firstTask).querySelector(".scheduled-task-status")?.textContent).toContain("Paused");
    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps a manual refresh active when the abandoned background read rejects", async () => {
    const previous = Promise.withResolvers<Response>();
    const current = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(catalog(firstTask))
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => button("Refresh").click());
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => previous.reject(new Error("Retired scheduled-task poll")));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".error-panel")).toBeNull();
    await act(async () => current.resolve(catalog(secondTask)));
    expect(container.textContent).toContain(secondTask.id);
    expect(container.textContent).not.toContain(firstTask.id);
  });

  it("does not reload a scheduler after an outstanding control settles on an unmounted page", async () => {
    const control = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(catalog(firstTask)).mockReturnValueOnce(control.promise);
    await mount();
    await act(async () => button("Run now", row(firstTask)).click());
    await act(async () => root.render(null));
    await act(async () => control.resolve(new Response(null, { status: 204 })));
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${dataPath}/catalog`, `${dataPath}/control`]);
  });

  it("updates relative timestamps independently and cancels both timers on unmount", async () => {
    const pending = Promise.withResolvers<Response>();
    const nearTask = {
      ...firstTask, state: { ...firstTask.state!, nextScheduledAt: new Date(now.getTime() + 500).toISOString() },
    };
    request.mockResolvedValueOnce(catalog(nearTask)).mockReturnValueOnce(pending.promise);
    await mount();
    const relative = () => row(nearTask).querySelector(".scheduled-task-time.next small")?.textContent;
    expect(relative()).toBe("in 1 second");
    expect(row(nearTask).querySelectorAll(".scheduled-task-time.next small")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(relative()).toBe("0 seconds ago");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(request).toHaveBeenCalledTimes(2);
    const signal = request.mock.lastCall?.[1]?.signal;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => pending.reject(new Error("Retired scheduler")));
    expect(container.querySelector(".scheduled-task-error")).toBeNull();
  });

  it("shows an unavailable page without sending a scheduler request", async () => {
    await mount(null);
    expect(container.querySelector(".error-panel")?.textContent).toBe("The scheduled-tasks page has no data endpoint.");
    expect(request).not.toHaveBeenCalled();
  });

  it("promotes relative timestamps to the next unit at the rounding boundary", async () => {
    const times = [
      [90_000, "in 2 minutes"],
      [5_400_000, "in 2 hours"],
      [129_600_000, "in 2 days"],
    ] as const;
    const tasks = times.map(([offset]) => ({
      ...firstTask,
      id: `test-${offset}`,
      state: { ...firstTask.state!, nextScheduledAt: new Date(now.getTime() + offset).toISOString() },
    }));
    request.mockResolvedValueOnce(catalog(...tasks));
    await mount();
    expect(tasks.map((task) => row(task).querySelector(".scheduled-task-time.next small")?.textContent))
      .toEqual(times.map(([, expected]) => expected));
  });

  it("distinguishes an uninitialized persistent task and formats short and distant run times", async () => {
    const pending: StudioScheduledTask = {
      ...localTask, id: "exports.pending", stateKind: "persistent",
      schedule: { kind: "cron", expression: "10 * * * *" },
    };
    const active: StudioScheduledTask = {
      ...secondTask, state: {
        paused: false, activeRuns: 0, lastOutcome: "failure",
        lastCompletedAt: "2026-11-12T07:00:00.000Z", nextScheduledAt: "2026-11-12T10:00:40.000Z",
      },
    };
    request.mockRejectedValueOnce("Scheduler network unavailable")
      .mockResolvedValueOnce(catalog(pending, active))
      .mockRejectedValueOnce("Control network unavailable");
    await mount();
    expect(container.textContent).toContain("Scheduler network unavailable");
    await act(async () => button("Retry").click());
    expect(row(pending).querySelector(".scheduled-task-status")?.textContent).toBe("Pending");
    expect(row(pending).querySelector('[data-label="Schedule"]')?.textContent).toBe("10 * * * *");
    expect(row(active).querySelector(".scheduled-task-status")?.textContent).toBe("Active");
    expect(row(active).querySelector('[data-label="Last run"]')?.textContent).toContain("3 hours ago");
    expect(row(active).querySelector('[data-label="Last run"]')?.textContent).toContain("Failed");
    expect(row(active).querySelector('[data-label="Next run"]')?.textContent).toContain("in 40 seconds");
    await act(async () => button("Run now", row(active)).click());
    expect(container.textContent).toContain("Control network unavailable");
    expect(button("Run now", row(active)).disabled).toBe(false);
  });
});
