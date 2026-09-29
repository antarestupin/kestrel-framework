import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

export const DEFAULT_CLIENT_ASSET_BASE_PATH = "/_client_assets/";

/** Transport-neutral description of one browser client mounted by the app. */
export interface WebClient {
  readonly basePath: string;
  readonly assetBasePath: string;
}

/** Request context available to SPA and future server-side renderers. */
export interface WebClientRenderContext {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

export type WebClientRender = (
  context: WebClientRenderContext,
) => Promise<unknown> | unknown;

/** Delivery boundary implemented by Vite and future client runtimes. */
export interface WebClientAdapter {
  setup(
    server: FastifyInstance,
    client: WebClient,
  ): Promise<WebClientRender>;
}
