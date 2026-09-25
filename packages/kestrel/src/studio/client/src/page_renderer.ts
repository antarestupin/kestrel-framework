import type { ReactNode } from "react";

import type { StudioPageManifest } from "../../extension.js";

/**
 * Maps a serializable Studio page kind to its client-side React renderer.
 */
export interface StudioPageRenderer {
  kind: string;
  render(page: StudioPageManifest): ReactNode;
}
