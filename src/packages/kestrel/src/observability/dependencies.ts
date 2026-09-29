import { dep } from "../di/index.js";
import type { ObserverContext } from "./context.js";
import type {
  ObservationRecorder,
  Observer,
} from "./observer.js";

/** Application-owned recorder shared by all execution scopes. */
export const observationRecorderDependency =
  dep<ObservationRecorder>("observationRecorder");

/** Observer enriched with the current execution identifier. */
export const observerDependency = dep<Observer>("observer");

/** Ambient bridge used by singleton Kestrel services during an execution. */
export const observerContextDependency =
  dep<ObserverContext>("observerContext");
