/** Stable asset prefix shared by Vite and the Fastify delivery provider. */
export const ATLAS_ASSET_BASE_PATH = "/_atlas_assets/";

/** Serializable session integration consumed by the browser client. */
export interface AtlasClientAuthenticationConfig {
  readonly loginPath: string;
  readonly passwordSignInUrl: string;
  readonly signOutUrl: string;
}

/** Minimal runtime configuration injected into the Kestrel-owned client. */
export interface AtlasClientConfig {
  readonly basePath: string;
  readonly title: string;
  readonly authentication?: AtlasClientAuthenticationConfig;
}
