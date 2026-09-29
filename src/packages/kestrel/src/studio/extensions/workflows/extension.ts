import { definition as faDiagramProject } from "@fortawesome/free-solid-svg-icons/faDiagramProject";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { ActionExecution } from "../../../app/index.js";
import { workflowExecutionCursorCodec } from "../../../workflows/execution_cursor.js";
import type { DefinitionCatalogRegistry } from "../../../definitions/index.js";
import { defineHttpController, get, post } from "../../../http/index.js";
import type {
  AnyWorkflow,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowHistoryEvent,
  WorkflowOperations,
} from "../../../workflows/index.js";
import type { StudioExtension } from "../../index.js";
import { fontAwesomeIcon, joinStudioPath } from "../../index.js";
import { studioHttpAccess } from "../../http_access.js";
import { getStudioObservationCorrelationPath } from "../observability/contract.js";
import {
  type StudioWorkflowCatalog,
  type StudioWorkflowExecution,
  type StudioWorkflowExecutionDetails,
  type StudioWorkflowExecutionPage,
  type StudioWorkflowHistoryEvent,
  WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
  WORKFLOWS_STUDIO_DATA_PATH,
  WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
  WORKFLOWS_STUDIO_EXTENSION_ID,
} from "./contract.js";

const workflowsIcon = fontAwesomeIcon(faDiagramProject);
const workflowStatuses = [
  "blocked",
  "cancelled",
  "cancelling",
  "completed",
  "failed",
  "pending",
  "queued",
  "running",
  "terminated",
  "waiting",
] as const satisfies readonly WorkflowExecutionStatus[];

export type WorkflowsStudioOperation =
  | "cancel"
  | "pause"
  | "read"
  | "recover"
  | "resume"
  | "retry"
  | "signal"
  | "terminate";

export interface WorkflowsStudioAuthorizationContext {
  operation: WorkflowsStudioOperation;
  executionId?: string;
  request: FastifyRequest;
  execution: ActionExecution;
}

export interface WorkflowsStudioExtensionOptions {
  /** Lets the application enforce operator policy beyond Studio route access. */
  authorize?: (
    context: WorkflowsStudioAuthorizationContext,
  ) => Promise<void> | void;
}

/** Adds durable workflow inventory, history and protected control seams to Studio. */
export function defineWorkflowsStudioExtension(
  registry: DefinitionCatalogRegistry<AnyWorkflow>,
  operations: WorkflowOperations,
  options: WorkflowsStudioExtensionOptions = {},
): StudioExtension {
  const executionInput = z.object({ executionId: z.string().min(1) });
  const listInput = z.object({
    // Validate at the HTTP boundary while retaining the token for the adapter.
    cursor: workflowExecutionCursorCodec.in.refine(
      (token) => workflowExecutionCursorCodec.safeParse(token).success,
      "Invalid workflow execution cursor.",
    ).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    search: z.string().trim().min(1).optional(),
    workflowName: z.string().min(1).optional(),
    workflowVersion: z.coerce.number().int().positive().optional(),
    status: z.enum(workflowStatuses).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    parentExecutionId: z.string().min(1).optional(),
    rootExecutionId: z.string().min(1).optional(),
    paused: z.enum(["false", "true"]).transform((value) => value === "true").optional(),
  });
  const signalInput = z.object({
    executionId: z.string().min(1),
    signalName: z.string().min(1),
    payload: z.unknown(),
    idempotencyKey: z.string().min(1).optional(),
  });
  const controlInput = z.object({
    executionId: z.string().min(1),
    action: z.enum(["cancel", "pause", "recover", "resume", "retry", "terminate"]),
    reason: z.string().trim().min(1).max(1_000).optional(),
    newExecutionId: z.string().min(1).optional(),
  });

  return {
    id: WORKFLOWS_STUDIO_EXTENSION_ID,
    title: "Durable workflows",
    description: "Inspect durable orchestration and operate individual executions.",
    icon: workflowsIcon,
    section: { id: "app", title: "App", order: 20 },
    pages: [
      {
        id: "catalog",
        title: "Workflows",
        path: "/workflows",
        description: "Definitions, versions and durable executions.",
        kind: WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
        icon: workflowsIcon,
        dataPath: WORKFLOWS_STUDIO_DATA_PATH,
        order: 40,
      },
      {
        id: "execution",
        title: "Workflow execution",
        path: "/workflows/$executionId",
        description: "Durable history, graph and operational controls.",
        kind: WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
        icon: workflowsIcon,
        dataPath: WORKFLOWS_STUDIO_DATA_PATH,
        showInNavigation: false,
      },
    ],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, WORKFLOWS_STUDIO_DATA_PATH);
      const authorize = (
        operation: WorkflowsStudioOperation,
        context: { request: FastifyRequest; execution: ActionExecution },
        executionId?: string,
      ) => options.authorize?.({
        operation,
        ...context,
        ...(executionId === undefined ? {} : { executionId }),
      });

      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/catalog`),
          description: "List deployed workflow definitions and version inventory.",
          handler: async ({ request, execution }): Promise<StudioWorkflowCatalog> => {
            await authorize("read", { request, execution });
            const [summaries, versions] = await Promise.all([
              operations.listDefinitions(),
              operations.inspectVersions(),
            ]);
            const byName = new Map(summaries.map((summary) => [summary.name, summary]));
            return {
              definitions: registry.registrations.map((registration) => {
                const summary = byName.get(registration.definition.name)!;
                return {
                  ...summary,
                  path: registration.path,
                  source: registration.source,
                  executions: summary.executions.map(({ workflowName: _name, ...item }) => item),
                };
              }),
              unsupportedActiveVersions: versions.unsupportedActiveVersions.map((item) => ({
                workflowName: item.workflowName,
                workflowVersion: item.workflowVersion,
                count: item.count,
                reason: item.reason,
              })),
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/executions`),
          description: "Search durable workflow executions.",
          input: listInput,
          handler: async ({ input, request, execution }): Promise<StudioWorkflowExecutionPage> => {
            await authorize("read", { request, execution });
            const page = await operations.listExecutions({
              limit: input.limit,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.search === undefined ? {} : { search: input.search }),
              ...(input.workflowName === undefined
                ? {}
                : { workflowNames: [input.workflowName] }),
              ...(input.workflowVersion === undefined
                ? {}
                : { workflowVersions: [input.workflowVersion] }),
              ...(input.status === undefined ? {} : { statuses: [input.status] }),
              ...(input.createdAfter === undefined
                ? {}
                : { createdAfter: input.createdAfter }),
              ...(input.createdBefore === undefined
                ? {}
                : { createdBefore: input.createdBefore }),
              ...(input.parentExecutionId === undefined
                ? {}
                : { parentExecutionId: input.parentExecutionId }),
              ...(input.rootExecutionId === undefined
                ? {}
                : { rootExecutionId: input.rootExecutionId }),
              ...(input.paused === undefined ? {} : { paused: input.paused }),
            });
            return {
              items: page.items.map(serializeExecution),
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: get(`${root}/executions/:executionId`),
          description: "Read one workflow execution, history and derived graph.",
          input: executionInput,
          handler: async ({ input, request, execution }): Promise<StudioWorkflowExecutionDetails> => {
            await authorize("read", { request, execution }, input.executionId);
            const details = await operations.getExecution(input.executionId);
            const definition = registry.definitions.find(({ name }) =>
              name === details.execution.workflowName);
            return {
              execution: serializeExecution(details.execution),
              declaredSignals: definition?.signals.map(({ name }) => name) ?? [],
              history: details.history.map(serializeHistoryEvent),
              archives: details.archives.map((archive) => ({
                historyGeneration: archive.historyGeneration,
                workflowVersion: archive.workflowVersion,
                eventCount: archive.history.length,
                continuedAt: archive.continuedAt.toISOString(),
              })),
              children: details.children.map(serializeExecution),
              retries: details.retries.map(serializeExecution),
              waits: details.waits.map((wait) => ({
                sequence: wait.sequence,
                kind: wait.kind,
                target: wait.target,
                scheduledAt: wait.scheduledAt.toISOString(),
                ...(wait.deadline === undefined
                  ? {}
                  : { deadline: wait.deadline.toISOString() }),
              })),
              graph: {
                nodes: details.graph.nodes.map((node) => ({
                  id: node.id,
                  kind: node.kind,
                  label: node.label,
                  status: node.status,
                  ...(node.executionId === undefined
                    ? {}
                    : { executionId: node.executionId }),
                  ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
                  ...(node.occurredAt === undefined
                    ? {}
                    : { occurredAt: node.occurredAt.toISOString() }),
                  ...(node.completedAt === undefined
                    ? {}
                    : { completedAt: node.completedAt.toISOString() }),
                })),
                edges: details.graph.edges,
              },
              observationPath: getStudioObservationCorrelationPath(
                "workflow.executionId",
                input.executionId,
              ),
            };
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/signals`),
          description: "Validate and deliver one declared workflow signal.",
          input: signalInput,
          successStatusCode: 200,
          handler: async ({ input, request, execution, reply }) => {
            await authorize("signal", { request, execution }, input.executionId);
            try {
              return await operations.signal({
                executionId: input.executionId,
                signalName: input.signalName,
                payload: input.payload,
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: input.idempotencyKey }),
              });
            } catch (error) {
              if (error instanceof z.ZodError || error instanceof TypeError) {
                return reply.code(400).send({
                  statusCode: 400,
                  error: "Bad Request",
                  message: error.message,
                });
              }
              throw error;
            }
          },
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/control`),
          description: "Pause, resume, cancel, recover, retry or terminate one execution.",
          input: controlInput,
          successStatusCode: 200,
          handler: async ({ input, request, execution, reply }) => {
            await authorize(input.action, { request, execution }, input.executionId);
            if (input.action === "retry") {
              try {
                const retried = await operations.retry(
                  input.executionId,
                  input.newExecutionId,
                );
                return { execution: serializeExecution(retried) };
              } catch (error) {
                if (error instanceof TypeError) {
                  return reply.code(409).send({
                    statusCode: 409,
                    error: "Conflict",
                    message: error.message,
                  });
                }
                throw error;
              }
            }
            const changed = input.action === "pause"
              ? await operations.pause(input.executionId)
              : input.action === "resume"
                ? await operations.resume(input.executionId)
                : input.action === "cancel"
                  ? await operations.cancel(input.executionId)
                  : input.action === "recover"
                    ? await operations.recover(input.executionId)
                    : await operations.terminate(input.executionId, input.reason);
            if (!changed) {
              return reply.code(409).send({
                statusCode: 409,
                error: "Conflict",
                message: `Workflow control "${input.action}" is not valid in the current state.`,
              });
            }
            return { changed: true };
          },
        }),
      ];
    },
  };
}

function serializeExecution(execution: WorkflowExecution): StudioWorkflowExecution {
  return {
    executionId: execution.executionId,
    workflowName: execution.workflowName,
    workflowVersion: execution.workflowVersion,
    historyGeneration: execution.historyGeneration,
    status: execution.status,
    input: execution.input,
    ...(execution.output === undefined ? {} : { output: execution.output }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
    createdAt: execution.createdAt.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
    ...(execution.completedAt === undefined
      ? {}
      : { completedAt: execution.completedAt.toISOString() }),
    ...(execution.pausedAt === undefined
      ? {}
      : { pausedAt: execution.pausedAt.toISOString() }),
    cancellationRequested: execution.cancellationRequested,
    ...(execution.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: execution.parentExecutionId }),
    ...(execution.parentCommandSequence === undefined
      ? {}
      : { parentCommandSequence: execution.parentCommandSequence }),
    rootExecutionId: execution.rootExecutionId,
    ...(execution.retryOfExecutionId === undefined
      ? {}
      : { retryOfExecutionId: execution.retryOfExecutionId }),
    ...(execution.concurrency?.keyed === undefined
      ? {}
      : { concurrencyKey: execution.concurrency.keyed.key }),
  };
}

function serializeHistoryEvent(event: WorkflowHistoryEvent): StudioWorkflowHistoryEvent {
  return { ...event, occurredAt: event.occurredAt.toISOString() };
}
