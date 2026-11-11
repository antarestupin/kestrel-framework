import { expect, it, vi } from "vitest";

import type { Observer } from "../observability/index.js";
import {
  recordThrottlingInstrumentation,
  type ThrottlingInstrumentationEvent,
} from "./observations.js";

const key = "partner-api";
const estimatedCost = { requests: 1 };
const actualCost = { requests: 2 };

const events = [
  {
    type: "acquisition", durationMs: 3, outcome: "success",
    data: { key, mode: "wait", result: "acquired", cost: 1, estimatedCost, constraints: 1, attempts: 2 },
  },
  {
    type: "completion", durationMs: 4, outcome: "success",
    data: { key, result: "success", cost: 2, estimatedCost, actualCost, reconciliation: "scheduled", heldDurationMs: 9 },
  },
  {
    type: "reconciliation", durationMs: 5, outcome: "failure",
    data: { key, result: "failed", estimatedCost, actualCost, constraints: 1 },
  },
  {
    type: "lease", durationMs: 0, outcome: "success",
    data: { key, operation: "return", units: 3, remaining: 0 },
  },
  {
    type: "circuit", durationMs: 0, outcome: "failure",
    data: { key, operation: "transition", state: "open", previousState: "closed", consecutiveFailures: 2, activeProbes: 0 },
  },
  {
    type: "pressure", durationMs: 0, outcome: "failure",
    data: { key, operation: "rejection", signal: "process.cpu", state: "limited", value: 1 },
  },
] satisfies readonly ThrottlingInstrumentationEvent[];

it.each(events)("routes $type to its observation with the original data and outcome", (event) => {
  const record = vi.fn<Observer["record"]>();

  // The scoped observer must receive a stable observation name for each event kind.
  recordThrottlingInstrumentation({ record }, event);
  expect(record).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: `throttling.${event.type}`, category: "throttling" }),
    event.data,
    { durationMs: event.durationMs, outcome: event.outcome },
  );
});
