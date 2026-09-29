import { definition as faCalendarDays } from "@fortawesome/free-solid-svg-icons/faCalendarDays";
import { z } from "zod";

import { defineHttpController, get, post } from "../../../http/index.js";
import type {
  RegisteredScheduledTask,
  ScheduledTaskAdapter,
  ScheduledTaskRegistry,
  ScheduledTaskState,
  ScheduledTaskStateKind,
} from "../../../scheduled_tasks/index.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import type { StudioExtension } from "../../index.js";
import { joinStudioPath } from "../../index.js";
import { studioHttpAccess } from "../../http_access.js";
import {
  type StudioScheduledTask,
  type StudioScheduledTaskCatalog,
  type StudioScheduledTaskCatalogNode,
  type StudioScheduledTaskGroup,
  type StudioScheduledTaskSchedule,
  SCHEDULED_TASKS_STUDIO_EXTENSION_ID,
  SCHEDULED_TASKS_STUDIO_PAGE_KIND,
} from "./contract.js";

const scheduledTasksIcon = fontAwesomeIcon(faCalendarDays);

export interface ScheduledTasksStudioExtensionOptions {
  defaultState: ScheduledTaskStateKind;
  now?: () => Date;
}

/** Adds recurring-task inspection and persistent-state controls to Studio. */
export function defineScheduledTasksStudioExtension(
  registry: ScheduledTaskRegistry,
  adapter: ScheduledTaskAdapter,
  options: ScheduledTasksStudioExtensionOptions,
): StudioExtension {
  const now = options.now ?? (() => new Date());
  const dataPath = "/api/extensions/scheduled-tasks" as const;
  const taskInput = z.object({
    taskId: z.string().min(1),
    action: z.enum(["pause", "resume", "run"]),
  });

  return {
    id: SCHEDULED_TASKS_STUDIO_EXTENSION_ID,
    title: "Scheduled tasks",
    icon: scheduledTasksIcon,
    description: "Inspect recurring tasks and control their next executions.",
    section: { id: "app", title: "App", order: 20 },
    pages: [{
      id: "catalog",
      title: "Scheduled tasks",
      path: "/scheduled-tasks",
      description: "Schedules, execution state and runtime controls.",
      kind: SCHEDULED_TASKS_STUDIO_PAGE_KIND,
      icon: scheduledTasksIcon,
      dataPath,
      order: 30,
    }],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, dataPath);

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/catalog`),
          description: "List registered scheduled tasks and current state.",
          handler: async (): Promise<StudioScheduledTaskCatalog> => {
            const registrations = registry.registrations;
            const persistentIds = registrations
              .filter((registration) => getStateKind(
                registration,
                options.defaultState,
              ) === "persistent")
              .map(({ task }) => task.id);
            const states = await adapter.listStates(persistentIds);
            const statesById = new Map(states.map((state) => [
              state.taskId,
              state,
            ]));

            return {
              nodes: documentRegistry(
                registrations,
                statesById,
                options.defaultState,
              ),
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/control`),
          description: "Run, pause or resume one persistent scheduled task.",
          input: taskInput,
          successStatusCode: 204,
          handler: async ({ input, reply }) => {
            const registration = registry.registrations.find(
              ({ task }) => task.id === input.taskId,
            );

            if (registration === undefined) {
              return reply.code(404).send({
                statusCode: 404,
                error: "Not Found",
                message: `Scheduled task "${input.taskId}" is not registered.`,
              });
            }

            if (getStateKind(registration, options.defaultState) === "memory") {
              return reply.code(409).send({
                statusCode: 409,
                error: "Conflict",
                message: "Process-local scheduled tasks cannot be controlled from Studio.",
              });
            }

            const [state] = await adapter.listStates([input.taskId]);

            if (state === undefined) {
              return reply.code(409).send({
                statusCode: 409,
                error: "Conflict",
                message: "The scheduled-task runtime has not registered this task yet.",
              });
            }

            if (input.action === "run") {
              await adapter.requestRun(input.taskId);
            } else if (input.action === "pause") {
              await adapter.setPaused(input.taskId, true);
            } else {
              const currentTime = now();
              const initial = registration.task.schedule.initial(currentTime);
              const resumeAt = initial.getTime() > currentTime.getTime()
                ? initial
                : registration.task.schedule.next({
                    scheduledAt: initial,
                    completedAt: currentTime,
                  });
              await adapter.setPaused(input.taskId, false, resumeAt);
            }
          },
        }),
      ];
    },
  };
}

function getStateKind(
  registration: RegisteredScheduledTask,
  defaultState: ScheduledTaskStateKind,
): ScheduledTaskStateKind {
  return registration.task.runtime.state ?? defaultState;
}

function documentRegistry(
  registrations: readonly RegisteredScheduledTask[],
  statesById: ReadonlyMap<string, ScheduledTaskState>,
  defaultState: ScheduledTaskStateKind,
): readonly StudioScheduledTaskCatalogNode[] {
  const application = createGroup("application", "Application");
  const providers = createGroup("providers", "Providers");

  for (const registration of registrations) {
    const root = registration.source.kind === "application"
      ? application
      : getOrCreateGroup(
          providers,
          `providers.${registration.source.provider}`,
          registration.source.provider,
        );
    appendTask(root, registration, statesById, defaultState);
  }

  return [application, providers].filter((group) => group.children.length > 0);
}

function appendTask(
  root: MutableStudioScheduledTaskGroup,
  registration: RegisteredScheduledTask,
  statesById: ReadonlyMap<string, ScheduledTaskState>,
  defaultState: ScheduledTaskStateKind,
): void {
  let parent = root;
  const branches = registration.path.slice(0, -1);

  for (const branch of branches) {
    parent = getOrCreateGroup(parent, `${parent.id}.${branch}`, branch);
  }

  parent.children.push(documentTask(registration, statesById, defaultState));
}

interface MutableStudioScheduledTaskGroup extends StudioScheduledTaskGroup {
  children: StudioScheduledTaskCatalogNode[];
}

function createGroup(id: string, name: string): MutableStudioScheduledTaskGroup {
  return { kind: "group", id, name, children: [] };
}

function getOrCreateGroup(
  parent: MutableStudioScheduledTaskGroup,
  id: string,
  name: string,
): MutableStudioScheduledTaskGroup {
  const existing = parent.children.find((child) =>
    child.kind === "group" && child.id === id);

  if (existing !== undefined && existing.kind === "group") {
    return existing as MutableStudioScheduledTaskGroup;
  }

  const group = createGroup(id, name);
  parent.children.push(group);
  return group;
}

function documentTask(
  registration: RegisteredScheduledTask,
  statesById: ReadonlyMap<string, ScheduledTaskState>,
  defaultState: ScheduledTaskStateKind,
): StudioScheduledTask {
  const stateKind = getStateKind(registration, defaultState);
  const state = statesById.get(registration.task.id);
  const controllable = stateKind === "persistent" && state !== undefined;

  return {
    kind: "task",
    id: registration.task.id,
    ...(registration.task.description === undefined
      ? {}
      : { description: registration.task.description }),
    groups: registration.task.groups,
    overlap: registration.task.overlap,
    executionLog: registration.task.executionLog,
    observe: registration.task.observe,
    source: registration.source,
    stateKind,
    schedule: documentSchedule(registration.task.schedule),
    controllable,
    ...(!controllable
      ? {
          unavailableReason: stateKind === "memory"
            ? "Process-local state is not shared with Studio."
            : "Waiting for the scheduled-task runtime to register this task.",
        }
      : {}),
    ...(state === undefined ? {} : { state: documentState(state) }),
  };
}

function documentSchedule(
  schedule: RegisteredScheduledTask["task"]["schedule"],
): StudioScheduledTaskSchedule {
  if (schedule.kind === "every") {
    return {
      kind: "every",
      intervalMs: schedule.intervalMs,
      start: schedule.start,
    };
  }

  if (schedule.kind === "loop") {
    return { kind: "loop", delayMs: schedule.delayMs, start: schedule.start };
  }

  return {
    kind: "cron",
    expression: schedule.expression,
    ...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
  };
}

function documentState(state: ScheduledTaskState) {
  return {
    paused: state.paused,
    activeRuns: state.activeRuns,
    ...(state.nextScheduledAt === undefined
      ? {}
      : { nextScheduledAt: state.nextScheduledAt.toISOString() }),
    ...(state.manualRunRequestedAt === undefined
      ? {}
      : { manualRunRequestedAt: state.manualRunRequestedAt.toISOString() }),
    ...(state.lastStartedAt === undefined
      ? {}
      : { lastStartedAt: state.lastStartedAt.toISOString() }),
    ...(state.lastCompletedAt === undefined
      ? {}
      : { lastCompletedAt: state.lastCompletedAt.toISOString() }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.lastError === undefined
      ? {}
      : {
          lastError: {
            name: state.lastError.name,
            message: state.lastError.message,
          },
        }),
  };
}
