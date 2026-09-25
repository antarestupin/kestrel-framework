import type { StudioPageRenderer } from "./page_renderer.js";

const pageRenderers = new Map<string, StudioPageRenderer>();

/** Registers a renderer when its owning client extension is installed. */
export function addStudioPageRenderer(renderer: StudioPageRenderer): void {
  // Replacing the same kind keeps extension registration compatible with HMR.
  pageRenderers.set(renderer.kind, renderer);
}

/** Resolves the renderer contributed for a serialized page kind. */
export function getStudioPageRenderer(
  kind: string,
): StudioPageRenderer | undefined {
  return pageRenderers.get(kind);
}
