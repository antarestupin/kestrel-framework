import type { RateLimitReservationRequest } from "../../types.js";

/** Identifies the durable bucket settings independently of one reservation's cost. */
export function rateLimitDefinitionSignature(request: RateLimitReservationRequest): string {
  const coordination = request.coordination;
  return JSON.stringify([request.limit, request.periodMs, request.burst,
    coordination?.strategy === "leased"
      ? [coordination.maxLeaseUnits, coordination.leaseMs, coordination.maxOutstandingUnits, coordination.guardBandUnits]
      : "exact",
  ]);
}
