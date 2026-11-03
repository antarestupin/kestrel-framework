import type { AtlasFieldManifest, AtlasManifest, AtlasResourceManifest } from "../../contract.js";
import type { AtlasHistoryPage } from "../../history.js";

/** Combine actor identities with sparse business relations in the same batch plan. */
export function createHistoryRelationContext(
  manifest: AtlasManifest,
  resource: AtlasResourceManifest,
  fields: readonly string[],
  events: AtlasHistoryPage["events"],
) {
  const visibleFields = resource.fields.filter((field) => fields.includes(field.id) && !field.hidden);
  const target = manifest.history?.actor?.resource;
  let actorField: AtlasFieldManifest | undefined;
  if (target !== undefined) {
    // Keep the synthetic metadata key separate from any application business field.
    let id = "__atlas_history_actor";
    while (resource.fields.some((field) => field.id === id) || fields.includes(id)) id += "_";
    actorField = {
      id, label: "Actor", kind: "relation", schema: { type: "string" },
      hidden: false, readOnly: true, searchable: false, filterOperators: [], sortable: false,
      relation: { resource: target, cardinality: "one", optional: true },
    };
  }
  return {
    actorField,
    resource: { ...resource, fields: actorField ? [...visibleFields, actorField] : visibleFields },
    records: events.map((event) => actorField
      ? { ...event.values, [actorField.id]: event.actor }
      : event.values),
  };
}
