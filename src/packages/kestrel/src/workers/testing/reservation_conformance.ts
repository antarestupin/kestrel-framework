import { expect, it } from "vitest";

import type { WorkerAdapter } from "../types.js";

/** Exercises repeated ordered preferences through both built-in backends. */
export function workerReservationConformance(createAdapter: () => WorkerAdapter): void {
  it.each(["allocation", "overflow"] as const)(
    "counts each job once when a queue preference repeats during %s",
    async (pass) => {
      const adapter = createAdapter();
      const firstCount = pass === "allocation" ? 2 : 3;
      const secondCount = pass === "allocation" ? 1 : 2;
      const ids = await adapter.enqueue([
        ...Array.from({ length: firstCount }, (_, payload) => ({ queue: "first", payload })),
        ...Array.from({ length: secondCount }, (_, payload) => ({ queue: "second", payload })),
      ]);
      const jobs = await adapter.reserve({
        queues: ["first", "first", "second"].map((queue) => ({
          queue, reservationLimit: 1, allowOverflow: pass === "overflow",
        })),
        totalLimit: ids.length,
        leaseMs: 60_000,
      });

      // PostgreSQL does not guarantee the UPDATE RETURNING order.
      expect(jobs.map(({ id }) => id).sort()).toEqual([...ids].sort());
      expect(jobs.map(({ attempt }) => attempt)).toEqual(ids.map(() => 1));
      expect(new Set(jobs.map(({ reservationToken }) => reservationToken)).size).toBe(ids.length);
    },
  );
}
