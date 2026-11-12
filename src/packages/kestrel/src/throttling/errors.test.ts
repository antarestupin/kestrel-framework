import { expect, it } from "vitest";

import {
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
  ThrottlingCircuitOpenError,
  ThrottlingClosedError,
  ThrottlingCostExceedsBurstError,
  ThrottlingCostValidationError,
  ThrottlingDefinitionConflictError,
  ThrottlingPermitCompletedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
  ThrottlingResourcePressureError,
} from "./errors.js";

it("exposes actionable error identities and preserves admission metadata", () => {
  const id = "partner";
  const retryAt = new Date(1_000);
  const cause = new Error("disconnected");

  // Preserve retry information for callers translating failures into HTTP and queue decisions.
  const rejected = new ThrottlingRejectedError(id, retryAt, "authoritative", 0.25);
  expect(rejected).toMatchObject({ name: "ThrottlingRejectedError", definitionId: id,
    message: 'Throttling rejected admission for "partner".', retryAt, source: "authoritative", remaining: 0.25 });
  const circuit = new ThrottlingCircuitOpenError(id, "vendor", retryAt);
  expect(circuit).toBeInstanceOf(ThrottlingRejectedError);
  expect(circuit).toMatchObject({ name: "ThrottlingCircuitOpenError", definitionId: id, circuitId: "vendor",
    message: 'Circuit "vendor" rejected admission for "partner".', retryAt, source: "local" });
  const pressure = new ThrottlingResourcePressureError(id, "host", ["cpu"]);
  expect(pressure).toBeInstanceOf(ThrottlingRejectedError);
  expect(pressure).toMatchObject({ name: "ThrottlingResourcePressureError", definitionId: id, constraintId: "host",
    message: 'Local resource pressure "host" rejected admission for "partner".', signalIds: ["cpu"], source: "local" });
  expect(pressure.retryAt).toBeUndefined();

  for (const [error, name, message] of [
    [new ThrottlingAcquisitionAbortedError(id), "ThrottlingAcquisitionAbortedError", 'Throttling admission was aborted for "partner".'],
    [new ThrottlingAcquisitionTimeoutError(id), "ThrottlingAcquisitionTimeoutError", 'Timed out waiting for throttling capacity for "partner".'],
    [new ThrottlingPermitCompletedError(id), "ThrottlingPermitCompletedError", 'The throttling permit for "partner" is already completed.'],
    [new ThrottlingQueueFullError(id), "ThrottlingQueueFullError", 'The throttling wait queue is full for "partner".'],
  ] as const) {
    expect(error).toMatchObject({ name, message, definitionId: id });
  }
  expect(new ThrottlingClosedError()).toMatchObject({ name: "ThrottlingClosedError", message: "The throttling manager is closed." });
  expect(new ThrottlingCostExceedsBurstError(id, 6, 4)).toMatchObject({ name: "ThrottlingCostExceedsBurstError",
    message: 'Throttling cost 6 exceeds burst 4 for "partner".', definitionId: id, cost: 6, burst: 4 });
  expect(new ThrottlingCostValidationError("missing cost")).toMatchObject({ name: "ThrottlingCostValidationError", message: "missing cost" });
  expect(new ThrottlingBackendUnavailableError({ cause })).toMatchObject({ name: "ThrottlingBackendUnavailableError",
    message: "The authoritative throttling backend is unavailable.", cause });
  expect(new ThrottlingDefinitionConflictError("account")).toMatchObject({ name: "ThrottlingDefinitionConflictError",
    message: 'Throttling key "account" already uses another rate limit policy.', key: "account" });
  expect(new ThrottlingAdapterCapabilityError("atomic reservations")).toMatchObject({ name: "ThrottlingAdapterCapabilityError",
    message: "The throttling adapter does not support atomic reservations.", capability: "atomic reservations" });
});
