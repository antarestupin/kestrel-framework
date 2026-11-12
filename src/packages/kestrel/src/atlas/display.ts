import type { AtlasResource } from "./resource.js";
import type { CatalogAtlasOperationExecutor } from "./source.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const key = (value: unknown) => `${typeof value}:${JSON.stringify(value)}`;

/** Validate explicit raw-field dependencies without traversing target display definitions. */
export function validateDisplays(resources: readonly AtlasResource[]): void {
  for (const resource of resources) {
    const manifest = resource.toManifest();
    for (const selection of Object.values(resource.getDisplay?.()?.select ?? {})) {
      const field = manifest.fields.find(({ id }) => id === (typeof selection === "string" ? selection : selection.relation));
      if (!field || field.id === "__atlas_display") throw new TypeError(`Invalid Atlas display dependency on ${resource.id}.`);
      if (typeof selection === "string") continue;
      const target = resources.find(({ id }) => id === field.relation?.resource)?.toManifest();
      if (field.relation?.cardinality !== "one" || !target?.fields.some(({ id }) => id === selection.field && id !== "__atlas_display")) {
        throw new TypeError(`Invalid Atlas display relation on ${resource.id}.${selection.relation}.`);
      }
    }
  }
}

/** Resolve one response in batches, preserving source authorization and business output. */
export async function resolveDisplayLabels(
  resources: readonly AtlasResource[], resourceId: string, data: unknown,
  executor: CatalogAtlasOperationExecutor,
  outputShape?: "record" | "array" | "list",
): Promise<{ labels: readonly string[]; shape: "record" | "array" | "list" } | undefined> {
  const resource = resources.find(({ id }) => id === resourceId)!;
  const display = resource.getDisplay?.();
  if (!display || data == null) return undefined;
  // Capability roles disambiguate records that happen to contain an items array.
  const shape = outputShape ?? (Array.isArray(data) ? "array" : isRecord(data) && Array.isArray(data.items) ? "list" : "record");
  const rows: unknown[] = shape === "array" ? data as unknown[] : shape === "list" ? (data as { items: unknown[] }).items : [data];
  if (!Array.isArray(rows) || !rows.every(isRecord)) throw new TypeError("Invalid Atlas display records.");
  const manifest = resource.toManifest();
  const targets = new Map<string, Map<string, unknown>>();
  // Merge identifiers across dependencies pointing at the same Resource.
  for (const selection of Object.values(display.select)) {
    if (typeof selection === "string") continue;
    const field = manifest.fields.find(({ id }) => id === selection.relation)!;
    const targetId = field.relation!.resource;
    const ids = targets.get(targetId) ?? new Map<string, unknown>();
    for (const row of rows) {
      const id = row[selection.relation];
      if (id != null) ids.set(key(id), id);
    }
    targets.set(targetId, ids);
  }
  const loaded = new Map<string, Map<string, Record<string, unknown>>>();
  await Promise.all([...targets].map(async ([targetId, identifiers]) => {
    const target = resources.find(({ id }) => id === targetId)!;
    const targetManifest = target.toManifest();
    const readMany = target.getOperationExposures().find(({ id }) => id === targetManifest.capabilities.readMany.id)!;
    const records = new Map<string, Record<string, unknown>>();
    const ids = [...identifiers.values()];
    const size = target.readManyBatchSize ?? 100;
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new TypeError("Atlas readManyBatchSize must be a positive safe integer.");
    }
    // Bound each operation to the source's declared batch budget.
    for (let offset = 0; offset < ids.length; offset += size) {
      const batch = ids.slice(offset, offset + size);
      const requested = new Set(batch.map(key));
      const response = await readMany.reference.execute({ ids: batch }, executor);
      if (!Array.isArray(response.data) || !response.data.every(isRecord)) throw new TypeError("Invalid Atlas display readMany output.");
      // Only use records associated with this batch's authorized lookup.
      for (const row of response.data) {
        const identity = key(row[targetManifest.identity]);
        if (requested.has(identity)) records.set(identity, row);
      }
    }
    loaded.set(targetId, records);
  }));
  return { shape, labels: rows.map((row) => {
    const values = Object.fromEntries(Object.entries(display.select).map(([alias, selection]) => {
      if (typeof selection === "string") return [alias, row[selection]];
      const targetId = manifest.fields.find(({ id }) => id === selection.relation)!.relation!.resource;
      return [alias, loaded.get(targetId)?.get(key(row[selection.relation]))?.[selection.field]];
    }));
    const label = display.format(values);
    if (label !== undefined && typeof label !== "string") throw new TypeError("Atlas display format must return a string or undefined synchronously.");
    return label === undefined || label === "" ? String(row[manifest.identity]) : label;
  }) };
}
