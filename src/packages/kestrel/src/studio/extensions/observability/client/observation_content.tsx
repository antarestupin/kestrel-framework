import type { StudioObservation } from "../contract.js";
import { getObservationRenderer } from "./observation_renderer.js";

/** Delegates observation data to the renderer registered for its stable name. */
export function ObservationContent({ event }: { event: StudioObservation }) {
  const Renderer = getObservationRenderer(event.name);

  return <Renderer event={event} />;
}
