import type { StudioPageRenderer } from "./page_renderer.js";
import { getStudioPageRenderer } from "./page_renderer_registry.js";

/** Describes one lightweight entrypoint that can load extension renderers. */
export interface StudioClientExtensionDefinition {
  readonly pageKinds: readonly string[];
  load(): Promise<unknown>;
}

// Definitions stay eager so Studio can discover page kinds without eagerly
// loading the substantially larger React implementations behind them.
const clientDefinitions = import.meta.glob<StudioClientExtensionDefinition>(
  "../../extensions/*/client/definition.ts",
  { eager: true, import: "studioClientExtension" },
);

const definitionsByPageKind = new Map<string, StudioClientExtensionDefinition>();
const rendererLoads = new Map<
  string,
  Promise<StudioPageRenderer | undefined>
>();

for (const definition of Object.values(clientDefinitions)) {
  for (const pageKind of definition.pageKinds) {
    definitionsByPageKind.set(pageKind, definition);
  }
}

/** Loads the extension owning a page kind and resolves its registered renderer. */
export async function loadStudioPageRenderer(
  kind: string,
): Promise<StudioPageRenderer | undefined> {
  const registeredRenderer = getStudioPageRenderer(kind);

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
    .then(() => getStudioPageRenderer(kind))
    .catch((error: unknown) => {
      // A later navigation may retry a transient chunk delivery failure.
      rendererLoads.delete(kind);
      throw error;
    });

  rendererLoads.set(kind, load);

  return load;
}

export { getStudioPageRenderer } from "./page_renderer_registry.js";
