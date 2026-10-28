import type { AtlasResourceManifest } from "../../contract.js";

/** Preserve declaration order within sections and order sections by first appearance. */
export function groupNavigationResources<Resource extends Pick<AtlasResourceManifest, "navigationGroup">>(resources: readonly Resource[]) {
  const groups = new Map<string | undefined, { label: string | undefined; resources: Resource[] }>();
  for (const resource of resources) {
    const label = resource.navigationGroup;
    let group = groups.get(label);
    if (group === undefined) {
      group = { label, resources: [] };
      groups.set(label, group);
    }
    group.resources.push(resource);
  }
  return [...groups.values()];
}
