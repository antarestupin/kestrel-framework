import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";
import type { EmailErrorCode } from "./errors.js";

export type EmailSendResult = "accepted" | EmailErrorCode;

export interface EmailSendObservationData extends ObservationData {
  client: string;
  operation: string;
  transport: string;
  result: EmailSendResult;
  recipientCount: number;
  attachmentCount: number;
  captureId?: string;
}

/** Describes one logical handoff to an outbound email transport. */
export const emailSendObservation =
  defineObservation<EmailSendObservationData>({
    name: "email.send",
    category: "email",
  });

export interface EmailInstrumentationEvent {
  readonly observationId: string;
  readonly durationMs: number;
  readonly outcome: ObservationOutcome;
  readonly data: EmailSendObservationData;
}

/** Synchronous storage-neutral sink implemented by observers or metrics. */
export interface EmailInstrumentation {
  record(event: EmailInstrumentationEvent): void;
}

/** Forwards email instrumentation to the current scoped observer. */
export function recordEmailInstrumentation(
  observer: Observer,
  event: EmailInstrumentationEvent,
): void {
  observer.record(emailSendObservation, event.data, {
    id: event.observationId,
    durationMs: event.durationMs,
    outcome: event.outcome,
  });
}
