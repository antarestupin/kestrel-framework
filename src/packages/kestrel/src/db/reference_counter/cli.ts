import { z } from "zod";

import { defineCliController } from "../../cli/controller.js";
import { option } from "../../cli/bindings.js";
import { dep } from "../../di/index.js";
import type { ReferenceCounterMaintenance } from "./maintenance.js";

/** Runs within the App, emitting committed progress independently of the result. */
export const referenceCounterCliControllers = {
  rebuild: defineCliController({
    command: "database counter rebuild",
    description: "Rebuild a reference counter in committed batches; resume with --after.",
    runningMode: "minimal",
    observe: false,
    input: z.object({
      id: z.string().min(1),
      batchSize: z.coerce.number().int().min(1).max(10_000).default(100),
      pauseMs: z.coerce.number().int().min(0).max(60_000).default(50),
      after: z.string().min(1).optional(),
    }),
    bindings: { batchSize: option("batch-size"), pauseMs: option("pause-ms") },
    dependencies: { counters: dep<ReferenceCounterMaintenance>("referenceCounterMaintenance") },
    handler: async ({ input, deps, execution, writeProgress }) => {
      const cancellation = new AbortController();
      const stop = () => cancellation.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        return await deps.counters.rebuild(input.id, {
          batchSize: input.batchSize,
          pauseMs: input.pauseMs,
          ...(input.after === undefined ? {} : { after: input.after }),
          signal: AbortSignal.any([execution.signal, cancellation.signal]),
          onProgress: ({ processed, updated, cursor }) => {
            writeProgress?.(`Counter: ${input.id} | Processed: ${processed} | Updated: ${updated} | Resume cursor: ${cursor}`);
          },
        });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  }),
} as const;
