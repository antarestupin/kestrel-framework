# Observability

[Usage index](./README.md) · [Implementation and recorder contracts](../implementation/observability.md)

Use typed observations for structured execution diagnostics. Observations do not drive business behavior; use [events](./events.md) when listeners must act on a notification.

## Record a typed observation

Emit an observation when a diagnostic timeline needs a structured business milestone. This import summary records a count and outcome alongside the current execution identity.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { defineObservation, observerDependency, type ObservationData } from "@kestrel/framework/observability";

interface ImportSummary extends ObservationData { imported: number }
const importCompleted = defineObservation<ImportSummary>({ name: "import.completed", category: "import" });
const summarizeImport = defineAction({
  name: "import.summarize", input: z.object({ imported: z.number().int() }), output: z.void(),
  dependencies: { observer: observerDependency },
  handler: ({ imported }, { observer }) => {
    // Recording is synchronous; storage is owned by the application recorder.
    observer.record(importCompleted, { imported }, { outcome: "success", durationMs: 12 });
  },
});
```

The observer adds identity, time and the current execution ID. Producers own payload redaction; observation types are compile-time contracts. Instrumented Kestrel dependencies automatically correlate with the current execution when recording is enabled.

## Enable application recording

Enable the provider when development executions should persist observations for inspection in Studio. Compose its database, logger and observation storage prerequisites first.

```ts
import type { App } from "@kestrel/framework/app";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { observationConfigBase, ObservationProvider } from "@kestrel/framework/observability";

const configuration = createConfigurationApi({ environments: ["development"], defaultEnvironment: "development" });
const config = configuration.resolveConfig({
  // Keep diagnostic storage failures from failing explicit flush or close boundaries.
  observations: configure(observationConfigBase, { enabled: true, failurePolicy: "best-effort" }),
}, { environment: "development", env: {} });
function enableObservations<Config>(app: App<Config>) {
  // Database and logger providers, plus development observation storage, are prerequisites.
  return app.register(new ObservationProvider(config.observations));
}
```

The standard provider writes to the disposable development observation table and can be disabled with `enabled: false`. Studio consumes the observation source for execution timelines. Unified telemetry and Beacon remain [design records](../implementation/README.md#design-records-and-future-work) in this checkout.

## Capture observations without a database

Use a standalone recorder for a test or integration that supplies its own storage callback. Explicit flush and close boundaries let the owner wait for buffered observations.

```ts
import { BufferedObservationRecorder, ScopedObserver, type ObservationEvent } from "@kestrel/framework/observability";

const recorded: ObservationEvent[] = [];
const recorder = new BufferedObservationRecorder({
  // The standalone owner chooses where each buffered batch is stored.
  append: async (events) => { recorded.push(...events); },
});
const observer = new ScopedObserver("example-execution", recorder);
observer.record(importCompleted, { imported: 3 });
// Wait for buffered events before inspecting capture state.
await recorder.flush();
const health = recorder.getHealth();
// Drain and close the recorder before releasing its storage resources.
await recorder.close();
```

`drop-new` bounds pending events; sustained storage failure can lose observations. `best-effort` accounts for losses without failing flush/close; `fail-fast` reports retained terminal failures at those explicit boundaries. `record()` cannot throw an asynchronous storage failure back into its producer. Application disposal flushes observations before releasing storage; standalone owners must do the same.

## Use cases still to document

- Install development observation storage and connect Studio execution timelines.
- Tune buffering and failure policy, then inspect recorder health after a storage failure.
- Choose diagnostic destinations and disable automatic observations for selected tasks.
