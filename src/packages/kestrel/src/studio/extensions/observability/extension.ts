import { definition as faClockRotateLeft } from "@fortawesome/free-solid-svg-icons/faClockRotateLeft";
import { definition as faEye } from "@fortawesome/free-solid-svg-icons/faEye";
import { z } from "zod";

import {
  del,
  defineHttpController,
  get,
} from "../../../http/index.js";
import type { DevObservationSource } from "../../../observability/source.js";
import type { DevLogSource } from "../../../log/db/log_store.js";
import type { StudioExtension } from "../../extension.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import {
  DEV_OBSERVATIONS_DATA_PATH,
  DEV_OBSERVATIONS_EXTENSION_ID,
  DEV_OBSERVATION_CORRELATION_PAGE_KIND,
  DEV_OBSERVATION_LIST_PAGE_KIND,
  DEV_OBSERVATION_EXECUTION_PAGE_KIND,
  DEV_OBSERVATIONS_PAGE_KIND,
  type StudioObservationExecutionPage,
  type StudioObservationPage,
  type StudioExecutionLogs,
  type StudioObservationTimeline,
} from "./contract.js";
import { readStudioLogWorkload } from "../logs/contract.js";

const executionsIcon = fontAwesomeIcon(faClockRotateLeft);
const observationsIcon = fontAwesomeIcon(faEye);

const executionsInputSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
const timelineInputSchema = z.object({
  executionId: z.string().min(1),
  contextKey: z.string().min(1).max(100).optional(),
});
const observationsInputSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  category: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  outcome: z.enum(["failure", "success"]).optional(),
});

/** Adds the execution explorer API and correlated telemetry to Studio. */
export function defineDevObservationsExtension(
  source: DevObservationSource,
  logSource: DevLogSource,
): StudioExtension {
  const dataPath = DEV_OBSERVATIONS_DATA_PATH;

  return {
    id: DEV_OBSERVATIONS_EXTENSION_ID,
    title: "Development observations",
    icon: executionsIcon,
    description: "Inspect Kestrel observations grouped by execution.",
    section: { id: "observability", title: "Observability", order: 30 },
    pages: [
      {
        id: "executions",
        title: "Executions",
        path: "/executions",
        description: "Requests and commands captured by the local application.",
        kind: DEV_OBSERVATIONS_PAGE_KIND,
        icon: executionsIcon,
        dataPath,
        order: 10,
      },
      {
        id: "observations",
        title: "Observations",
        path: "/observations",
        description: "All Kestrel observations captured by the local application.",
        kind: DEV_OBSERVATION_LIST_PAGE_KIND,
        icon: observationsIcon,
        dataPath,
        order: 20,
      },
      {
        id: "execution",
        title: "Execution",
        path: "/executions/$executionId",
        description: "Observations captured during one application execution.",
        kind: DEV_OBSERVATION_EXECUTION_PAGE_KIND,
        icon: executionsIcon,
        dataPath,
        showInNavigation: false,
      },
      {
        id: "correlation",
        title: "Correlated executions",
        path: "/correlations/$contextKey/$executionId",
        description: "Observations captured across correlated application executions.",
        kind: DEV_OBSERVATION_CORRELATION_PAGE_KIND,
        icon: executionsIcon,
        dataPath,
        showInNavigation: false,
      },
    ],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, dataPath);

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/observations`),
          description: "List captured development observations.",
          input: observationsInputSchema,
          handler: async ({ input }) => {
            // Preserve absent optional fields for exact optional semantics.
            const page = await source.listObservations({
              ...(input.before === undefined ? {} : { before: input.before }),
              ...(input.category === undefined
                ? {}
                : { category: input.category }),
              ...(input.executionId === undefined
                ? {}
                : { executionId: input.executionId }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.outcome === undefined
                ? {}
                : { outcome: input.outcome }),
            });
            const response: StudioObservationPage = {
              items: page.items.map(serializeObservation),
              nextBefore: page.nextBefore,
            };

            return response;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: del(`${root}/observations`),
          description: "Clear captured development observations.",
          successStatusCode: 204,
          handler: async () => {
            await source.clear();
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/executions`),
          description: "List observed application executions.",
          input: executionsInputSchema,
          handler: async ({ input }) => {
            const page = await source.listExecutions({
              ...(input.before === undefined ? {} : { before: input.before }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            });
            const response: StudioObservationExecutionPage = {
              items: page.items.map((execution) => ({
                ...execution,
                startedAt: execution.startedAt.toISOString(),
                completedAt: execution.completedAt?.toISOString() ?? null,
              })),
              nextBefore: page.nextBefore,
            };

            return response;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/events`),
          description: "List the observation timeline for one execution.",
          input: timelineInputSchema,
          handler: async ({ input }) => {
            const events = input.contextKey === undefined
              ? await source.listEvents(input.executionId)
              : await source.listEventsByContext(
                  input.contextKey,
                  input.executionId,
                );
            const response: StudioObservationTimeline = {
              executionId: input.executionId,
              items: events.map(serializeObservation),
            };

            return response;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/logs`),
          description: "List structured logs correlated with one execution.",
          input: timelineInputSchema,
          handler: async ({ input }) => {
            const events = input.contextKey === undefined
              ? []
              : await source.listEventsByContext(
                  input.contextKey,
                  input.executionId,
                );
            const executionIds = input.contextKey === undefined
              ? [input.executionId]
              : [...new Set(events.map((event) => event.executionId))];
            const logs = input.contextKey === undefined
              ? await logSource.listByExecution(input.executionId)
              : await logSource.listByExecutions(executionIds);
            const response: StudioExecutionLogs = {
              executionId: input.executionId,
              items: logs.map((log) => ({
                ...log,
                loggedAt: log.loggedAt.toISOString(),
                createdAt: log.createdAt.toISOString(),
                workload: readStudioLogWorkload(log.payload),
              })),
            };

            return response;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: del(`${root}/executions`),
          description: "Clear captured development observations.",
          successStatusCode: 204,
          handler: async () => {
            await source.clear();
          },
        }),
      ];
    },
  };
}

/** Converts the database representation into the transport-neutral contract. */
function serializeObservation(
  event: Awaited<ReturnType<DevObservationSource["listEvents"]>>[number],
): StudioObservationPage["items"][number] {
  return {
    sequence: event.sequence,
    id: event.id,
    executionId: event.executionId,
    occurredAt: event.occurredAt.toISOString(),
    name: event.name,
    category: event.category,
    schemaVersion: event.schemaVersion,
    outcome: event.outcome,
    durationMs: event.durationMs,
    data: event.data,
  };
}
