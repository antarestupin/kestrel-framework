import {
  createContext,
  type ComponentType,
  type ReactNode,
  useContext,
} from "react";

import type {
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationInputManifest,
  AtlasOperationManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import type { HydratedRelationReference } from "./relations.js";
import type {
  RecordActionProperties,
  RecordProperties,
  ResourceProperties,
  ResourceViewProperties,
} from "./pages.js";
import type { AtlasHomeProperties } from "./home_page.js";
import type { AtlasLayoutProperties } from "./router-view.js";

export interface AtlasFieldRendererProperties {
  readonly basePath?: string;
  readonly field: AtlasFieldManifest;
  readonly onOpenRelation?: (resourceId: string, recordId: string) => void;
  readonly relationReferences?: readonly HydratedRelationReference[];
  readonly resource?: AtlasResourceManifest;
  readonly value: unknown;
}

export interface AtlasInputRendererProperties {
  readonly definition: AtlasOperationInputManifest;
  readonly field?: AtlasFieldManifest | undefined;
  readonly manifest?: AtlasManifest;
  readonly resource?: AtlasResourceManifest;
  readonly value?: unknown;
}

export interface AtlasOperationControlRendererProperties {
  readonly icon?: "delete" | "play" | "save";
  readonly label: string;
  readonly onExecute?: () => void;
  readonly operation: AtlasOperationManifest;
  readonly pending: boolean;
  readonly presentation?: "menu" | "primary";
  readonly role?: "menuitem";
  readonly tone?: "danger" | "default";
  readonly type?: "button" | "submit";
}

export type AtlasFieldRenderer = ComponentType<
  AtlasFieldRendererProperties
>;
export type AtlasInputRenderer = ComponentType<
  AtlasInputRendererProperties
>;
/** Renders presentational content inside a Kestrel-owned operation control. */
export type AtlasOperationControlRenderer = ComponentType<
  AtlasOperationControlRendererProperties
>;
export type AtlasViewRenderer = ComponentType<ResourceViewProperties>;

/** Replaceable page-level regions used by the lightweight application template. */
export interface AtlasPageRenderers {
  readonly layout: ComponentType<AtlasLayoutProperties>;
  readonly home: ComponentType<AtlasHomeProperties>;
  readonly resourceList: ComponentType<ResourceProperties>;
  readonly resourceRead: ComponentType<RecordProperties>;
  readonly resourceCreate: ComponentType<ResourceProperties>;
  readonly resourceEdit: ComponentType<RecordProperties>;
  readonly recordAction: ComponentType<RecordActionProperties>;
  readonly notFound: () => ReactNode;
}

/** Application-local renderer registries keyed by stable semantic identifiers. */
export interface AtlasRendererRegistries {
  readonly fields?: Readonly<Record<string, AtlasFieldRenderer>>;
  readonly inputs?: Readonly<Record<string, AtlasInputRenderer>>;
  readonly operationControls?: Readonly<
    Record<string, AtlasOperationControlRenderer>
  >;
  readonly pages?: Partial<AtlasPageRenderers>;
  readonly views?: Readonly<Record<string, AtlasViewRenderer>>;
}

const AtlasRendererRegistryContext = createContext<
  AtlasRendererRegistries
>({});

/** Makes one application's renderer contributions available to reusable UI. */
export function AtlasRendererRegistryProvider({
  children,
  registries,
}: {
  readonly children: ReactNode;
  readonly registries: AtlasRendererRegistries;
}) {
  return (
    <AtlasRendererRegistryContext.Provider value={registries}>
      {children}
    </AtlasRendererRegistryContext.Provider>
  );
}

/** Resolves the renderer registries belonging to the current application. */
export function useAtlasRendererRegistries(): AtlasRendererRegistries {
  return useContext(AtlasRendererRegistryContext);
}

/** Resolves the first registered renderer from most to least specific key. */
export function resolveAtlasRenderer<Renderer>(
  registry: Readonly<Record<string, Renderer>> | undefined,
  keys: readonly (string | undefined)[],
): Renderer | undefined {
  for (const key of keys) {
    if (key !== undefined && registry?.[key] !== undefined) {
      return registry[key];
    }
  }

  return undefined;
}
