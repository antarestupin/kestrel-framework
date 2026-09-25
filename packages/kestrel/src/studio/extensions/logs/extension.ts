import { definition as faFileLines } from "@fortawesome/free-solid-svg-icons/faFileLines";
import { z } from "zod";

import {
  appWorkloads,
} from "../../../app/workloads.js";
import {
  del,
  defineHttpController,
  get,
} from "../../../http/index.js";
import type { DevLogSource } from "../../../log/db/log_store.js";
import type { StudioExtension } from "../../extension.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import {
  DEV_LOGS_EXTENSION_ID,
  DEV_LOGS_PAGE_KIND,
  readStudioLogWorkload,
  type StudioLogPage,
} from "./contract.js";

const logsIcon = fontAwesomeIcon(faFileLines);

const logsInputSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  level: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  workload: z.enum([...appWorkloads, "system"]).optional(),
});

/**
 * Adds the local log explorer API and page to Studio.
 */
export function defineDevLogsExtension(
  source: DevLogSource,
): StudioExtension {
  const dataPath = "/api/extensions/development-logs/logs" as const;

  return {
    id: DEV_LOGS_EXTENSION_ID,
    title: "Development logs",
    icon: logsIcon,
    description: "Inspect structured events emitted by the local application.",
    section: { id: "observability", title: "Observability", order: 30 },
    pages: [
      {
        id: "logs",
        title: "Logs",
        path: "/logs",
        description: "Structured Pino events captured in the local database.",
        kind: DEV_LOGS_PAGE_KIND,
        icon: logsIcon,
        dataPath,
        order: 30,
      },
    ],
    defineHttpControllers({ basePath }) {
      const route = joinStudioPath(basePath, dataPath);

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(route),
          description: "List captured development logs.",
          input: logsInputSchema,
          handler: async ({ input }) => {
            // Omit absent query fields to preserve exact optional semantics.
            const page = await source.list({
              ...(input.before === undefined
                ? {}
                : { before: input.before }),
              ...(input.level === undefined
                ? {}
                : { level: input.level }),
              ...(input.limit === undefined
                ? {}
                : { limit: input.limit }),
              ...(input.workload === undefined
                ? {}
                : { workload: input.workload }),
            });
            const response: StudioLogPage = {
              items: page.items.map((log) => ({
                ...log,
                loggedAt: log.loggedAt.toISOString(),
                createdAt: log.createdAt.toISOString(),
                workload: readStudioLogWorkload(log.payload),
              })),
              nextBefore: page.nextBefore,
            };

            return response;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: del(route),
          description: "Clear captured development logs.",
          successStatusCode: 204,
          handler: async () => {
            await source.clear();
          },
        }),
      ];
    },
  };
}
