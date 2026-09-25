/** Browser-safe catalog of workloads that can contribute application activity. */
export const appWorkloads = [
  "http",
  "scheduled-tasks",
  "workers",
  "workflows",
] as const;

export type AppWorkload = typeof appWorkloads[number];
