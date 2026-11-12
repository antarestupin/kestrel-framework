import { loadAtlasRelationRecords, relationIdentifierKey, type RelationRecord } from "./relation_loader.js";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import type {
  AtlasFieldManifest,
  AtlasManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import { readAtlasRecordField } from "./runtime.js";

export interface RelationHydrationRequest {
  readonly resource: AtlasResourceManifest;
  readonly ids: readonly unknown[];
}

/** One hydrated relation value that can open its target record. */
export interface HydratedRelationReference {
  readonly resourceId: string;
  readonly recordId?: string;
  readonly label: unknown;
}

/**
 * Groups and deduplicates every relation identifier by target Resource.
 */
export function createRelationHydrationRequests(
  manifest: AtlasManifest,
  resource: AtlasResourceManifest,
  records: readonly Readonly<Record<string, unknown>>[],
): readonly RelationHydrationRequest[] {
  const identifiersByResource = new Map<
    string,
    Map<string, unknown>
  >();

  for (const field of resource.fields) {
    if (field.hidden || field.relation === undefined) {
      continue;
    }

    const identifiers = identifiersByResource.get(field.relation.resource)
      ?? new Map<string, unknown>();

    identifiersByResource.set(field.relation.resource, identifiers);

    for (const record of records) {
      const value = readAtlasRecordField(record, field.id);
      const values = field.relation.cardinality === "many"
        ? Array.isArray(value) ? value : []
        : [value];

      for (const identifier of values) {
        if (identifier !== null && identifier !== undefined) {
          identifiers.set(serializeIdentifier(identifier), identifier);
        }
      }
    }
  }

  return [...identifiersByResource].flatMap(([resourceId, identifiers]) => {
    const target = manifest.resources.find(
      (candidate) => candidate.id === resourceId,
    );

    return target === undefined || identifiers.size === 0
      ? []
      : [{ resource: target, ids: [...identifiers.values()] }];
  });
}

/** Resolves a raw relation identifier to its configured display value. */
export function resolveRelationValue(
  field: AtlasFieldManifest,
  value: unknown,
  recordsByResource: ReadonlyMap<
    string,
    readonly RelationRecord[] | ReadonlyMap<string, RelationRecord>
  >,
  target?: AtlasResourceManifest,
): unknown {
  const relation = field.relation;

  if (relation === undefined || value === null || value === undefined) {
    return value;
  }

  const targetRecords = recordsByResource.get(relation.resource) ?? [];
  // Callers with array-backed data can rely on the conventional identity.
  const identity = target?.identity ?? "id";
  const displayField = relation.displayField ?? target?.displayField ?? identity;
  const resolveOne = (identifier: unknown) => {
    const record = findRelationRecord(targetRecords, identity, identifier);

    return readAtlasRecordField(record, displayField) ?? identifier;
  };

  return relation.cardinality === "many" && Array.isArray(value)
    ? value.map(resolveOne)
    : resolveOne(value);
}

/** Resolves relation labels together with their target Resource identities. */
export function resolveRelationReferences(
  manifest: AtlasManifest,
  field: AtlasFieldManifest,
  value: unknown,
  recordsByResource: ReadonlyMap<
    string,
    readonly RelationRecord[] | ReadonlyMap<string, RelationRecord>
  >,
): readonly HydratedRelationReference[] {
  const relation = field.relation;

  if (relation === undefined || value === null || value === undefined) {
    return [];
  }

  const target = manifest.resources.find(
    (resource) => resource.id === relation.resource,
  );
  const targetRecords = recordsByResource.get(relation.resource) ?? [];
  const identity = target?.identity ?? "id";
  const displayField = relation.displayField ?? target?.displayField ?? identity;
  const values = relation.cardinality === "many" && Array.isArray(value)
    ? value
    : [value];

  return values.flatMap((identifier) => {
    // An empty relation value is not an addressable target.
    if (identifier == null) return [];
    const record = findRelationRecord(targetRecords, identity, identifier);
    return [{
      resourceId: relation.resource,
      recordId: String(readAtlasRecordField(record, identity) ?? identifier),
      label: readAtlasRecordField(record, displayField) ?? identifier,
    }];
  });
}

/** Loads visible relations in bounded batches, reusing per-identity cached records. */
export function useRelationHydration(
  manifest: AtlasManifest,
  resource: AtlasResourceManifest,
  records: readonly Readonly<Record<string, unknown>>[],
) {
  const client = useQueryClient();
  const requests = createRelationHydrationRequests(
    manifest,
    resource,
    records,
  );
  const queries = useQueries({
    queries: requests.map((request) => ({
      queryKey: [request.resource.id, "readMany", manifest.basePath, request.ids],
      queryFn: () => loadAtlasRelationRecords(client, manifest.basePath, request.resource, request.ids),
    })),
  });
  const recordsByResource = new Map(
    requests.map((request, index) => [
      request.resource.id,
      new Map((queries[index]?.data ?? []).map((row) => [serializeIdentifier(readAtlasRecordField(row, request.resource.identity)), row])),
    ]),
  );

  return {
    error: queries.find((query) => query.isError)?.error,
    isPending: queries.some((query) => query.isPending),
    resolve: (field: AtlasFieldManifest, value: unknown) => {
      const targetResource = field.relation === undefined
        ? undefined
        : manifest.resources.find(
          (candidate) => candidate.id === field.relation?.resource,
        );

      return resolveRelationValue(
        field,
        value,
        recordsByResource,
        targetResource,
      );
    },
    references: (field: AtlasFieldManifest, value: unknown) =>
      resolveRelationReferences(manifest, field, value, recordsByResource),
  };
}

function serializeIdentifier(identifier: unknown): string {
  return relationIdentifierKey(identifier);
}

/** Hook callers index each target once, avoiding a scan for every matrix cell. */
function findRelationRecord(records: readonly RelationRecord[] | ReadonlyMap<string, RelationRecord>, identity: string, identifier: unknown) {
  return Array.isArray(records)
    ? records.find((row) => serializeIdentifier(readAtlasRecordField(row, identity)) === serializeIdentifier(identifier))
    : (records as ReadonlyMap<string, RelationRecord>).get(serializeIdentifier(identifier));
}
