/** Stable identifiers shared by the workers Studio extension and its client. */
export const WORKERS_STUDIO_EXTENSION_ID = "workers";
export const WORKERS_STUDIO_PAGE_KIND = "workers.queues";
export const WORKER_STUDIO_PAGE_KIND = "workers.worker";

/** Returns the canonical Studio-relative path for one worker. */
export function getStudioWorkerPath(workerId: string): `/workers/${string}` {
  return `/workers/${encodeURIComponent(workerId)}`;
}

export type StudioWorkerJsonSchema = boolean | Record<string, unknown>;

export interface StudioWorkerExample {
  name: string;
  payload: unknown;
}

/** Serializable worker details and live queue state. */
export interface StudioWorkerQueue {
  kind: "worker";
  id: string;
  name: string;
  description?: string;
  queue: string;
  enabled: boolean;
  ready: number;
  scheduled: number;
  reserved: number;
  inputSchema: StudioWorkerJsonSchema;
  examples: readonly StudioWorkerExample[];
}

/** Preserves one branch from the application worker catalog. */
export interface StudioWorkerGroup {
  kind: "group";
  id: string;
  name: string;
  children: readonly StudioWorkerCatalogNode[];
}

export type StudioWorkerCatalogNode = StudioWorkerGroup | StudioWorkerQueue;

export interface StudioWorkerObservability {
  dataPath: string;
}

export interface StudioWorkerCatalog {
  nodes: readonly StudioWorkerCatalogNode[];
  observability?: StudioWorkerObservability;
}

export interface StudioWorkerDetail {
  worker: StudioWorkerQueue;
  observability?: StudioWorkerObservability;
}

export interface StudioWorkerEnqueueResult {
  jobId: string;
  executionId: string;
}
