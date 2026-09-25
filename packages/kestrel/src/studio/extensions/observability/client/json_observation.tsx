import type { StudioObservation } from "../contract.js";

/** Displays the lossless fallback shared by unknown observation types. */
export function JsonObservation({ event }: { event: StudioObservation }) {
  return (
    <pre className="observation-json">
      {JSON.stringify(event.data, null, 2)}
    </pre>
  );
}
