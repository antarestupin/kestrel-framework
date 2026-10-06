import { uuidV7 } from "../utils/uuid.js";
import type {
  ObservationData,
  ObservationDefinition,
  ObservationDefinitionData,
} from "./definitions.js";

export type ObservationOutcome = "failure" | "success";

/** Complete storage-neutral event accepted by an observation recorder. */
export interface ObservationEvent {
  readonly id: string;
  readonly executionId: string;
  readonly occurredAt: Date;
  readonly name: string;
  readonly category: string;
  readonly schemaVersion: number;
  readonly outcome?: ObservationOutcome;
  readonly durationMs?: number;
  readonly data: ObservationData;
}

export interface RecordObservationOptions {
  /** Optional identity reserved by a producer before asynchronous recording. */
  id?: string;
  occurredAt?: Date;
  outcome?: ObservationOutcome;
  durationMs?: number;
}

/** Non-blocking event recorder owned by the application lifecycle. */
export interface ObservationRecorder {
  enqueue(event: ObservationEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  getHealth(): ObservationRecorderHealth;
}

export type ObservationRecorderHealthStatus = "closed" | "degraded" | "healthy";

/** Storage-neutral health snapshot available to future health integrations. */
export interface ObservationRecorderHealth {
  readonly status: ObservationRecorderHealthStatus;
  readonly pendingCount: number;
  readonly droppedCount: number;
  readonly droppedByOverflow: number;
  readonly droppedByStorageFailure: number;
  readonly consecutiveStorageFailures: number;
  readonly oldestPendingAgeMs?: number;
}

/** Execution-scoped API used by instrumented Kestrel components. */
export interface Observer {
  record<
    Definition extends ObservationDefinition<ObservationData>,
  >(
    definition: Definition,
    data: ObservationDefinitionData<Definition>,
    options?: RecordObservationOptions,
  ): void;
}

/** Adds execution context before forwarding an event to the shared recorder. */
export class ScopedObserver implements Observer {
  public constructor(
    private readonly executionId: string,
    private readonly recorder: ObservationRecorder,
  ) {}

  public record<
    Definition extends ObservationDefinition<ObservationData>,
  >(
    definition: Definition,
    data: ObservationDefinitionData<Definition>,
    options: RecordObservationOptions = {},
  ): void {
    this.recorder.enqueue({
      id: options.id ?? uuidV7(),
      executionId: this.executionId,
      occurredAt: options.occurredAt ?? new Date(),
      name: definition.name,
      category: definition.category,
      schemaVersion: definition.schemaVersion,
      data,
      ...(options.outcome === undefined
        ? {}
        : { outcome: options.outcome }),
      ...(options.durationMs === undefined
        ? {}
        : { durationMs: options.durationMs }),
    });
  }
}

/** Safe default used when observation capture is disabled. */
export class NoopObservationRecorder implements ObservationRecorder {
  public enqueue(_event: ObservationEvent): void {}

  public async flush(): Promise<void> {}

  public async close(): Promise<void> {}

  public getHealth(): ObservationRecorderHealth {
    return {
      status: "healthy",
      pendingCount: 0,
      droppedCount: 0,
      droppedByOverflow: 0,
      droppedByStorageFailure: 0,
      consecutiveStorageFailures: 0,
    };
  }
}

/**
 * Stable recorder facade used while a lifecycle-owned backend starts or stops.
 * Events emitted without an active backend are intentionally ignored.
 */
export class DelegatingObservationRecorder implements ObservationRecorder {
  private readonly fallback = new NoopObservationRecorder();
  private active: ObservationRecorder = this.fallback;

  public use(recorder: ObservationRecorder): void {
    this.active = recorder;
  }

  public clear(recorder: ObservationRecorder): void {
    if (this.active === recorder) {
      this.active = this.fallback;
    }
  }

  public enqueue(event: ObservationEvent): void {
    this.active.enqueue(event);
  }

  public flush(): Promise<void> {
    return this.active.flush();
  }

  public close(): Promise<void> {
    return this.active.close();
  }

  public getHealth(): ObservationRecorderHealth {
    return this.active.getHealth();
  }
}
