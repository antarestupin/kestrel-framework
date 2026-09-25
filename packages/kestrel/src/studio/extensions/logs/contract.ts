import {
  appWorkloads,
  type AppWorkload,
} from "../../../app/workloads.js";

export const DEV_LOGS_EXTENSION_ID = "development-logs";
export const DEV_LOGS_PAGE_KIND = "development-logs";

/**
 * JSON representation shared by the local Studio API and its client page.
 */
export interface StudioLog {
  id: number;
  loggedAt: string;
  level: number;
  message: string | null;
  requestId: string | null;
  workload: AppWorkload | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StudioLogPage {
  items: readonly StudioLog[];
  nextBefore: number | null;
}

/** Reads only canonical workload bindings while older logs remain system logs. */
export function readStudioLogWorkload(
  payload: Record<string, unknown>,
): AppWorkload | null {
  const workload = payload.workload;

  return appWorkloads.find((candidate) => candidate === workload) ?? null;
}
