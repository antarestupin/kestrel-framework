/** Absorbs fractional rounding without turning an exhausted balance into capacity. */
export function canCoverRateLimitCost(remaining: number, cost: number): boolean {
  return remaining + Math.min(Number.EPSILON, Math.max(0, remaining) * Number.EPSILON) >= cost;
}
