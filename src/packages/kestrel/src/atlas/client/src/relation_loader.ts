import type { QueryClient } from "@tanstack/react-query";
import type { AtlasResourceManifest } from "../../contract.js";
import { executeAtlasOperation, isRecord, readAtlasRecordField } from "./runtime.js";

export type RelationRecord = Readonly<Record<string, unknown>>;
export const relationIdentifierKey = (value: unknown) => `${typeof value}:${JSON.stringify(value)}`;

/** Reuse positive and negative results briefly, with normal Resource cache invalidation. */
export async function loadRelationRecords(
  client: QueryClient,
  basePath: string,
  resource: AtlasResourceManifest,
  identifiers: readonly unknown[],
  readMany: (ids: readonly unknown[]) => Promise<readonly RelationRecord[]>,
): Promise<readonly RelationRecord[]> {
  const ids = [...new Map(identifiers.map((id) => [relationIdentifierKey(id), id])).values()];
  const cacheKey = (id: unknown) => [resource.id, "relation-value", basePath, id] as const;
  const records = new Map<string, RelationRecord>();
  const missing: unknown[] = [];
  for (const id of ids) {
    const state = client.getQueryState<{ record: RelationRecord | null }>(cacheKey(id));
    if (state?.data && !state.isInvalidated && Date.now() - state.dataUpdatedAt < 30_000) {
      if (state.data.record) records.set(relationIdentifierKey(id), state.data.record);
    } else missing.push(id);
  }
  const size = resource.readManyBatchSize ?? 100;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError("Atlas readManyBatchSize must be a positive safe integer.");
  }
  // Sequential chunks bound pressure on one target; different targets load concurrently.
  for (let offset = 0; offset < missing.length; offset += size) {
    const batch = missing.slice(offset, offset + size);
    const rows = await readMany(batch);
    const indexed = new Map(rows.map((row) => [relationIdentifierKey(readAtlasRecordField(row, resource.identity)), row]));
    for (const id of batch) {
      const record = indexed.get(relationIdentifierKey(id)) ?? null;
      client.setQueryData(cacheKey(id), { record });
      if (record) records.set(relationIdentifierKey(id), record);
    }
  }
  return [...records.values()];
}

/** Hydrates one target through the same bounded cache for lists and form pickers. */
export function loadAtlasRelationRecords(
  client: QueryClient,
  basePath: string,
  resource: AtlasResourceManifest,
  identifiers: readonly unknown[],
): Promise<readonly RelationRecord[]> {
  return loadRelationRecords(client, basePath, resource, identifiers, async (ids) => {
    const result = await executeAtlasOperation(basePath, resource.capabilities.readMany, { ids });
    if (!Array.isArray(result)) {
      throw new TypeError("The Resource readMany operation returned an invalid result.");
    }
    return result.filter(isRecord);
  });
}
