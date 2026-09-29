import type { HttpMethod } from "../../../http/index.js";

export const CONTROLLERS_STUDIO_EXTENSION_ID = "controllers";
export const CONTROLLERS_STUDIO_PAGE_KIND = "controllers.explorer";

/** JSON Schema subset transported to the Studio client. */
export type StudioJsonSchema = boolean | Record<string, unknown>;

/** Describes how one logical controller input enters the HTTP request. */
export interface StudioHttpControllerInput {
  name: string;
  sourceName: string;
  binding: "body" | "path" | "query";
  required: boolean;
  schema: StudioJsonSchema;
}

/** A complete logical input ready to populate the request editor. */
export interface StudioHttpControllerExample {
  name: string;
  input: Record<string, unknown>;
}

/** Serializable controller details displayed and executed by Studio. */
export interface StudioHttpControllerDefinition {
  kind: "controller";
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  access: string;
  description?: string;
  inputs: readonly StudioHttpControllerInput[];
  examples: readonly StudioHttpControllerExample[];
}

/** Preserves one branch from the application-owned controller catalog. */
export interface StudioHttpControllerGroup {
  kind: "group";
  id: string;
  name: string;
  children: readonly StudioHttpControllerCatalogNode[];
}

export type StudioHttpControllerCatalogNode =
  | StudioHttpControllerDefinition
  | StudioHttpControllerGroup;

export interface StudioHttpControllerCatalog {
  nodes: readonly StudioHttpControllerCatalogNode[];
  /** Optional observation endpoint and response-header correlation contract. */
  observability?: StudioHttpControllerObservability;
}

export interface StudioHttpControllerObservability {
  dataPath: string;
  executionIdHeader: string;
}
