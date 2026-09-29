import { dep } from "../di/index.js";
import type { WorkflowAdapter } from "./adapter.js";
import type { WorkflowClient } from "./client.js";
import type { WorkflowRuntime } from "./runtime.js";
import type { WorkflowOperations } from "./operations.js";

export const workflowAdapterDependency =
  dep<WorkflowAdapter>("workflowAdapter");
export const workflowClientDependency = dep<WorkflowClient>("workflowClient");
export const workflowOperationsDependency =
  dep<WorkflowOperations>("workflowOperations");
export const workflowRuntimeDependency =
  dep<WorkflowRuntime<any>>("workflowRuntime");
