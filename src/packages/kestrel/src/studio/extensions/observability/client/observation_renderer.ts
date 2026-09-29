import type { ComponentType } from "react";

import { databaseQueryObservation } from "../../../../db/observations.js";
import type { StudioObservation } from "../contract.js";
import { DatabaseQueryObservation } from "./database_query_observation.js";
import { JsonObservation } from "./json_observation.js";

export interface ObservationRendererProperties {
  event: StudioObservation;
}

const observationRenderers = new Map<
  string,
  ComponentType<ObservationRendererProperties>
>([
  [databaseQueryObservation.name, DatabaseQueryObservation],
]);

/** Selects a specialized renderer while retaining JSON for every other event. */
export function getObservationRenderer(
  observationName: string,
): ComponentType<ObservationRendererProperties> {
  return observationRenderers.get(observationName) ?? JsonObservation;
}
