import Fastify from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import type { DevObservationSource } from "../../../observability/db/observation_store.js";
import type { DevLogSource } from "../../../log/db/log_store.js";
import { defineDevObservationsExtension } from "./extension.js";
import {
  getStudioObservationCorrelationPath,
  getStudioObservationExecutionPath,
} from "./contract.js";
import { Studio } from "../../studio.js";

describe("development observations extension", () => {
  it("exposes execution pages and timelines", async () => {
    const source: DevObservationSource = {
      clear: vi.fn(async () => {}),
      getObservation: vi.fn(async () => undefined),
      listObservations: vi.fn(async () => ({
        items: [storedObservation()],
        nextBefore: 1,
      })),
      listExecutions: vi.fn(async () => ({
        items: [
          {
            executionId: "execution-1",
            operation: "GET /users/:id",
            transport: "http" as const,
            startedAt: new Date("2026-08-07T10:00:00.000Z"),
            completedAt: new Date("2026-08-07T10:00:00.025Z"),
            outcome: "success" as const,
            durationMs: 25,
          },
        ],
        nextBefore: null,
      })),
      listEvents: vi.fn(async () => [storedObservation()]),
      listEventsByContext: vi.fn(async () => [
        storedObservation(),
        storedDatabaseObservation(),
      ]),
    };
    const server = Fastify();
    const app = new App({});
    const logSource: DevLogSource = {
      clear: vi.fn(async () => {}),
      list: vi.fn(async () => ({ items: [], nextBefore: null })),
      listByExecution: vi.fn(async () => [{
        id: 3,
        loggedAt: new Date("2026-08-07T10:00:00.010Z"),
        level: 30,
        message: "User loaded",
        requestId: "req-1",
        payload: { executionId: "execution-1" },
        createdAt: new Date("2026-08-07T10:00:00.011Z"),
      }]),
      listByExecutions: vi.fn(async () => []),
    };
    const studio = new Studio({
      extensions: [defineDevObservationsExtension(source, logSource)],
    });
    const controllerManager = new HttpControllerManager(app, server);
    const manifest = studio.getManifest();

    for (const controller of await studio.defineHttpControllers()) {
      controllerManager.register(controller);
    }
    await app.start();

    const executions = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/executions",
    });
    const observations = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/observations?category=execution&name=execution.started&outcome=success&executionId=execution-1&before=2&limit=1",
    });
    const timeline = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/events?executionId=execution-1",
    });
    const logs = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/logs?executionId=execution-1",
    });
    const correlatedTimeline = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/events?executionId=workflow-1&contextKey=workflow.executionId",
    });
    const correlatedLogs = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-observations/logs?executionId=workflow-1&contextKey=workflow.executionId",
    });
    const clear = await server.inject({
      method: "DELETE",
      url: "/_studio/api/extensions/development-observations/observations",
    });

    expect(executions.statusCode).toBe(200);
    expect(executions.json()).toMatchObject({
      items: [{ executionId: "execution-1", durationMs: 25 }],
      nextBefore: null,
    });
    expect(observations.statusCode).toBe(200);
    expect(observations.json()).toMatchObject({
      items: [{ id: "00000000-0000-4000-8000-000000000001" }],
      nextBefore: 1,
    });
    expect(source.listObservations).toHaveBeenCalledWith({
      before: 2,
      category: "execution",
      executionId: "execution-1",
      limit: 1,
      name: "execution.started",
      outcome: "success",
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      executionId: "execution-1",
      items: [{ name: "execution.started" }],
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toMatchObject({
      executionId: "execution-1",
      items: [{ id: 3, message: "User loaded" }],
    });
    expect(logSource.listByExecution).toHaveBeenCalledWith("execution-1");
    expect(correlatedTimeline.statusCode).toBe(200);
    expect(correlatedTimeline.json()).toMatchObject({
      executionId: "workflow-1",
      items: [
        { name: "execution.started" },
        { name: "database.query" },
      ],
    });
    expect(correlatedLogs.statusCode).toBe(200);
    expect(source.listEventsByContext).toHaveBeenCalledWith(
      "workflow.executionId",
      "workflow-1",
    );
    expect(logSource.listByExecutions).toHaveBeenCalledWith(["execution-1"]);
    expect(clear.statusCode).toBe(204);
    expect(source.clear).toHaveBeenCalledOnce();
    expect(manifest.extensions[0]?.pages).toContainEqual({
      id: "observations",
      title: "Observations",
      path: "/observations",
      description: "All Kestrel observations captured by the local application.",
      kind: "development-observation-list",
      icon: "icon-2",
      dataPath: "/_studio/api/extensions/development-observations",
      order: 20,
    });
    expect(manifest.extensions[0]?.pages).toContainEqual({
      id: "correlation",
      title: "Correlated executions",
      path: "/correlations/$contextKey/$executionId",
      description: "Observations captured across correlated application executions.",
      kind: "development-observation-correlation",
      icon: "icon-1",
      dataPath: "/_studio/api/extensions/development-observations",
      showInNavigation: false,
    });
    expect(manifest.extensions[0]?.pages).toContainEqual({
      id: "execution",
      title: "Execution",
      path: "/executions/$executionId",
      description: "Observations captured during one application execution.",
      kind: "development-observation-execution",
      icon: "icon-1",
      dataPath: "/_studio/api/extensions/development-observations",
      showInNavigation: false,
    });
    expect(getStudioObservationExecutionPath("execution/with spaces")).toBe(
      "/executions/execution%2Fwith%20spaces",
    );
    expect(getStudioObservationCorrelationPath(
      "workflow.executionId",
      "workflow/with spaces",
    )).toBe(
      "/correlations/workflow.executionId/workflow%2Fwith%20spaces",
    );

    await server.close();
    await app.dispose();
  });
});

/** Creates a complete database row shared by list and timeline assertions. */
function storedObservation() {
  return {
    sequence: 1,
    id: "00000000-0000-4000-8000-000000000001",
    executionId: "execution-1",
    occurredAt: new Date("2026-08-07T10:00:00.000Z"),
    name: "execution.started",
    category: "execution",
    schemaVersion: 1,
    outcome: "success" as const,
    durationMs: 1,
    data: { operation: "GET /users/:id", transport: "http" },
    createdAt: new Date("2026-08-07T10:00:00.001Z"),
  };
}

/** Represents instrumentation attached to a correlated execution scope. */
function storedDatabaseObservation() {
  return {
    ...storedObservation(),
    sequence: 2,
    id: "00000000-0000-4000-8000-000000000002",
    occurredAt: new Date("2026-08-07T10:00:00.005Z"),
    name: "database.query",
    category: "database",
    data: { sql: "select 1" },
  };
}
