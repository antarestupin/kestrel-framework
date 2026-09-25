/**
 * Stable internal prefix used by Vite assets independently from Studio's
 * configurable application mount path.
 */
export const STUDIO_ASSET_BASE_PATH = "/_studio_assets/";

/** Maps source locations from the application runtime to the local editor. */
export interface StudioSourcePathMapping {
  runtimeRoot: string;
  editorRoot: string;
}

/** Small server-injected contract required before the Studio client starts. */
export interface StudioClientConfig {
  basePath: string;
  sourcePathMapping?: StudioSourcePathMapping;
}
