import type { StudioPageRenderer } from "./page_renderer.js";
import { getStudioPageRenderer } from "./page_renderer_registry.js";

/** Describes one lightweight entrypoint that can load extension renderers. */
export interface StudioClientExtensionDefinition {
  readonly pageKinds: readonly string[];
  load(): Promise<unknown>;
}

// Definitions stay eager so Studio can discover page kinds without eagerly
// loading the substantially larger React implementations behind them.
// Stryker disable all: Vite requires compile-time literal glob patterns and options.
const clientDefinitions = import.meta.glob<StudioClientExtensionDefinition>(
  "../../extensions/*/client/definition.ts",
  { eager: true, import: "studioClientExtension" },
);
// Stryker restore all

/** Shares in-flight page loads and releases a failed entry for the next navigation. */
export function createStudioPageLoader(
  definitions: readonly StudioClientExtensionDefinition[],
  resolveRenderer: (kind: string) => StudioPageRenderer | undefined,
): (kind: string) => Promise<StudioPageRenderer | undefined> {
  const definitionsByPageKind = new Map<string, StudioClientExtensionDefinition>();
  const rendererLoads = new Map<string, Promise<StudioPageRenderer | undefined>>();

  for (const definition of definitions) {
    for (const pageKind of definition.pageKinds) {
      definitionsByPageKind.set(pageKind, definition);
    }
  }

  return async (kind) => {
    const registeredRenderer = resolveRenderer(kind);

    if (registeredRenderer !== undefined) {
      return registeredRenderer;
    }

    const existingLoad = rendererLoads.get(kind);

    if (existingLoad !== undefined) {
      return existingLoad;
    }

    const definition = definitionsByPageKind.get(kind);

    if (definition === undefined) {
      return undefined;
    }

    const load = definition.load()
      .then(() => resolveRenderer(kind))
      .catch((error: unknown) => {
        // A later navigation may retry a transient chunk delivery failure.
        rendererLoads.delete(kind);
        throw error;
      });

    rendererLoads.set(kind, load);

    return load;
  };
}

/** Loads the extension owning a page kind and resolves its registered renderer. */
export const loadStudioPageRenderer = createStudioPageLoader(Object.values(clientDefinitions), getStudioPageRenderer);

export { getStudioPageRenderer } from "./page_renderer_registry.js";
