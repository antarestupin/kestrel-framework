import { definition as faGears } from "@fortawesome/free-solid-svg-icons/faGears";
import { z, type ZodType } from "zod";

import { createUuid } from "../../../utils/uuid.js";
import { safeParseSchema } from "../../../definitions/index.js";
import {
  defineHttpController,
  get,
  post,
} from "../../../http/index.js";
import {
  type CatalogTree,
  flattenCatalog,
  isWorker,
} from "../../../utils/index.js";
import type { WorkerAdapter } from "../../../workers/types.js";
import type { AnyWorker } from "../../../workers/worker.js";
import type { StudioExtension } from "../../index.js";
import { joinStudioPath } from "../../index.js";
import { studioHttpAccess } from "../../http_access.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import { DEV_OBSERVATIONS_DATA_PATH } from "../observability/contract.js";
import {
  type StudioWorkerCatalog,
  type StudioWorkerCatalogNode,
  type StudioWorkerDetail,
  type StudioWorkerEnqueueResult,
  type StudioWorkerExample,
  type StudioWorkerJsonSchema,
  type StudioWorkerQueue,
  WORKER_STUDIO_PAGE_KIND,
  WORKERS_STUDIO_EXTENSION_ID,
  WORKERS_STUDIO_PAGE_KIND,
} from "./contract.js";

const workersIcon = fontAwesomeIcon(faGears);

export interface WorkersStudioExtensionOptions {
  /** Enables live observation timelines for jobs enqueued from Studio. */
  observability?: boolean;
}

/** Adds queue controls, payload publishing and live job observations to Studio. */
export function defineWorkersStudioExtension(
  catalog: CatalogTree<AnyWorker>,
  adapter: WorkerAdapter,
  options: WorkersStudioExtensionOptions = {},
): StudioExtension {
  const workers = flattenCatalog(catalog, isWorker);
  const workersByQueue = new Map(workers.map((worker) => [
    worker.queue,
    worker,
  ]));
  const workersById = new Map(indexCatalogWorkers(catalog));
  const queueSchema = z.string().refine(
    (queue) => workersByQueue.has(queue),
    "The queue is not registered in the application worker catalog.",
  );
  const queueInputSchema = z.object({
    queue: queueSchema,
    enabled: z.boolean(),
  });
  const enqueueInputSchema = z.object({
    queue: queueSchema,
    payload: z.unknown(),
    executionId: z.uuid().optional(),
  });
  const workerDetailInputSchema = z.object({
    workerId: z.string().min(1),
  });
  const dataPath = "/api/extensions/workers" as const;

  return {
    id: WORKERS_STUDIO_EXTENSION_ID,
    title: "Workers",
    icon: workersIcon,
    description: "Inspect queues, publish jobs and follow their execution.",
    section: { id: "app", title: "App", order: 20 },
    pages: [
      {
        id: "queues",
        title: "Workers",
        path: "/workers",
        description: "Queue activity and consumption controls.",
        kind: WORKERS_STUDIO_PAGE_KIND,
        icon: workersIcon,
        dataPath,
        order: 20,
      },
      {
        id: "worker",
        title: "Worker",
        path: "/workers/$workerId",
        description: "Worker details and interactive job publishing.",
        kind: WORKER_STUDIO_PAGE_KIND,
        icon: workersIcon,
        dataPath,
        showInNavigation: false,
      },
    ],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, dataPath);

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/catalog`),
          description: "List the worker catalog and current queue state.",
          handler: async (): Promise<StudioWorkerCatalog> => {
            const statistics = await adapter.listQueueStatistics(
              workers.map((worker) => worker.queue),
            );
            const statisticsByQueue = new Map(statistics.map((queue) => [
              queue.queue,
              queue,
            ]));

            return {
              nodes: documentCatalog(catalog, statisticsByQueue),
              ...documentObservability(options, basePath),
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/catalog/:workerId`),
          description: "Return one worker and its current queue state.",
          input: workerDetailInputSchema,
          handler: async ({ input, reply }) => {
            const worker = workersById.get(input.workerId);

            if (worker === undefined) {
              return reply.code(404).send({
                statusCode: 404,
                error: "Not Found",
                message: `Worker "${input.workerId}" is not registered.`,
              });
            }

            const [statistics] = await adapter.listQueueStatistics([
              worker.queue,
            ]);

            if (statistics === undefined) {
              throw new Error(
                `Queue statistics are missing for "${worker.queue}".`,
              );
            }

            return {
              worker: documentWorker(input.workerId, worker, statistics),
              ...documentObservability(options, basePath),
            } satisfies StudioWorkerDetail;
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/queues/control`),
          description: "Enable or pause consumption for one worker queue.",
          input: queueInputSchema,
          successStatusCode: 204,
          handler: async ({ input }) => {
            await adapter.setQueueEnabled(input.queue, input.enabled);
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/enqueue`),
          description: "Validate and enqueue one worker payload.",
          input: enqueueInputSchema,
          handler: async ({ input, reply }) => {
            const worker = workersByQueue.get(input.queue)!;
            const payload = await safeParseSchema(
              worker.inputSchema, input.payload, worker.validation.input,
            );

            if (!payload.success) {
              return reply.code(400).send({
                statusCode: 400,
                error: "Bad Request",
                message: "The worker payload is invalid.",
                issues: payload.error.issues,
              });
            }

            const executionId = input.executionId ?? createUuid();
            const [jobId] = await adapter.enqueue([{
              queue: worker.queue,
              payload: payload.data,
              executionId,
            }]);

            if (jobId === undefined) {
              throw new Error(
                "The worker adapter did not return the enqueued job ID.",
              );
            }

            return {
              jobId,
              executionId,
            } satisfies StudioWorkerEnqueueResult;
          },
        }),
      ];
    },
  };
}

/** Indexes worker leaves by the same hierarchical IDs exposed to Studio. */
function indexCatalogWorkers(
  catalog: CatalogTree<AnyWorker>,
  parentId = "",
): readonly (readonly [string, AnyWorker])[] {
  return Object.entries(catalog).flatMap(([name, value]) => {
    const id = parentId === "" ? name : `${parentId}.${name}`;

    return isWorker(value)
      ? [[id, value] as const]
      : indexCatalogWorkers(value, id);
  });
}

function documentObservability(
  options: WorkersStudioExtensionOptions,
  basePath: string,
): Pick<StudioWorkerDetail, "observability"> | Record<string, never> {
  return options.observability === true
    ? {
        observability: {
          dataPath: joinStudioPath(basePath, DEV_OBSERVATIONS_DATA_PATH),
        },
      }
    : {};
}

function documentCatalog(
  catalog: CatalogTree<AnyWorker>,
  statisticsByQueue: ReadonlyMap<
    string,
    {
      queue: string;
      enabled: boolean;
      ready: number;
      scheduled: number;
      reserved: number;
    }
  >,
  parentId = "",
): readonly StudioWorkerCatalogNode[] {
  return Object.entries(catalog).map(([name, value]) => {
    const id = parentId === "" ? name : `${parentId}.${name}`;

    if (!isWorker(value)) {
      return {
        kind: "group",
        id,
        name,
        children: documentCatalog(value, statisticsByQueue, id),
      };
    }

    const statistics = statisticsByQueue.get(value.queue);

    if (statistics === undefined) {
      throw new Error(`Queue statistics are missing for "${value.queue}".`);
    }

    return documentWorker(id, value, statistics);
  });
}

function documentWorker(
  id: string,
  worker: AnyWorker,
  statistics: {
    queue: string;
    enabled: boolean;
    ready: number;
    scheduled: number;
    reserved: number;
  },
): StudioWorkerQueue {
  const inputSchema = toJsonSchema(worker.inputSchema);

  return {
    kind: "worker",
    id,
    name: worker.name,
    ...(worker.description === undefined
      ? {}
      : { description: worker.description }),
    ...statistics,
    inputSchema,
    examples: documentExamples(worker, inputSchema),
  };
}

function documentExamples(
  worker: AnyWorker,
  inputSchema: StudioWorkerJsonSchema,
): readonly StudioWorkerExample[] {
  if (worker.examples !== undefined && worker.examples.length > 0) {
    return worker.examples.map((example, index) => ({
      name: example.name ?? `Example ${index + 1}`,
      payload: example.payload,
    }));
  }

  return [{
    name: "Generated example",
    payload: generateExampleValue(inputSchema),
  }];
}

function toJsonSchema(schema: ZodType): StudioWorkerJsonSchema {
  try {
    return z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    });
  } catch {
    return {};
  }
}

function generateExampleValue(schema: StudioWorkerJsonSchema): unknown {
  if (typeof schema === "boolean") {
    return schema ? "example" : undefined;
  }

  if (Array.isArray(schema.examples)) {
    return schema.examples[0];
  }

  if (schema.default !== undefined) {
    return schema.default;
  }

  if (schema.const !== undefined) {
    return schema.const;
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum[0];
  }

  for (const alternativeKey of ["oneOf", "anyOf"] as const) {
    const alternatives = schema[alternativeKey];

    if (Array.isArray(alternatives) && alternatives.length > 0) {
      return generateExampleValue(
        alternatives[0] as StudioWorkerJsonSchema,
      );
    }
  }

  switch (schema.type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "array": {
      const itemSchema = Array.isArray(schema.items)
        ? schema.items[0]
        : schema.items;

      return itemSchema === undefined
        ? []
        : [generateExampleValue(itemSchema as StudioWorkerJsonSchema)];
    }
    case "object": {
      const properties = isRecord(schema.properties)
        ? schema.properties
        : {};

      return Object.fromEntries(Object.entries(properties).map(
        ([name, propertySchema]) => [
          name,
          generateExampleValue(propertySchema as StudioWorkerJsonSchema),
        ],
      ));
    }
    case "null":
      return null;
    case "string":
    default:
      return generateStringExample(schema.format);
  }
}

function generateStringExample(format: unknown): string {
  switch (format) {
    case "date":
      return "2026-01-01";
    case "date-time":
      return "2026-01-01T12:00:00.000Z";
    case "email":
      return "user@example.com";
    case "hostname":
      return "example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    default:
      return "example";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
