import { z } from "zod";

import { defineEvent } from "../events/index.js";
import { ExecutionContext } from "./execution_context.js";

const applicationLifecycleSchema = z.object({});
const startupStepTimingSchema = z.object({
  durationMs: z.number(),
  provider: z.string(),
});

/** Reports the complete startup profile once execution admission is open. */
export const applicationStartedEvent = defineEvent({
  name: "application.started",
  schema: z.object({
    runtime: z.string(),
    durations: z.object({
      bootstrapMs: z.number(),
      compositionMs: z.number(),
      totalMs: z.number(),
      providers: z.object({
        boot: z.array(startupStepTimingSchema),
        composition: z.array(startupStepTimingSchema),
      }),
    }),
  }),
});

/** Signals that registered providers may begin application initialization. */
export const bootstrapStartedEvent = defineEvent({
  name: "bootstrap.started",
  schema: applicationLifecycleSchema,
});

/** Signals that bootstrap work completed and runtime may start. */
export const bootstrapCompletedEvent = defineEvent({
  name: "bootstrap.completed",
  schema: applicationLifecycleSchema,
});

/** Signals that the transport may begin accepting executions. */
export const runtimeStartedEvent = defineEvent({
  name: "runtime.started",
  schema: applicationLifecycleSchema,
});

/** Signals that the runtime is transitioning away from accepting executions. */
export const runtimeStoppingEvent = defineEvent({
  name: "runtime.stopping",
  schema: applicationLifecycleSchema,
});

/** Signals that application resource cleanup is beginning. */
export const shutdownStartedEvent = defineEvent({
  name: "shutdown.started",
  schema: applicationLifecycleSchema,
});

/** Signals the last usable application boundary before resources are disposed. */
export const shutdownCompletedEvent = defineEvent({
  name: "shutdown.completed",
  schema: applicationLifecycleSchema,
});

export const executionOutcomeSchema = z.enum([
  "success",
  "failure",
  "cancelled",
]);

export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

/** Signals that an execution scope is initialized and ready for primary work. */
export const executionStartedEvent = defineEvent({
  name: "execution.started",
  schema: z.object({
    executionId: z.string(),
  }),
});

/** Signals that primary work completed while scoped resources remain usable. */
export const executionCompletedEvent = defineEvent({
  name: "execution.completed",
  schema: z.object({
    executionId: z.string(),
    outcome: executionOutcomeSchema,
    context: z.instanceof(ExecutionContext),
  }),
});
