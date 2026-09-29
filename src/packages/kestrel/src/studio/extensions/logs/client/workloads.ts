import type { AppWorkload } from "../../../../app/workloads.js";

export type StudioWorkloadFilter = "" | AppWorkload | "system";

/** Canonical workload choices shared by the explorer controls and row labels. */
export const studioWorkloadOptions = [
  { value: "", label: "All" },
  { value: "http", label: "HTTP" },
  { value: "workers", label: "Workers" },
  { value: "scheduled-tasks", label: "Scheduled tasks" },
  { value: "workflows", label: "Workflows" },
  { value: "system", label: "System" },
] as const satisfies readonly {
  value: StudioWorkloadFilter;
  label: string;
}[];

/** Formats a persisted workload, including unscoped system events. */
export function getStudioWorkloadLabel(
  workload: AppWorkload | null,
): string {
  if (workload === null) return "System";

  return studioWorkloadOptions.find((option) => option.value === workload)
    ?.label ?? workload;
}
