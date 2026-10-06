import { useQueries } from "@tanstack/react-query";

import type {
  AtlasFieldManifest,
  AtlasManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  executeAtlasOperation,
  isRecord,
} from "./runtime.js";

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
    if (field.relation === undefined) {
      continue;
    }

    const identifiers = identifiersByResource.get(field.relation.resource)
      ?? new Map<string, unknown>();

    identifiersByResource.set(field.relation.resource, identifiers);

    for (const record of records) {
      const value = record[field.id];
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
    readonly Readonly<Record<string, unknown>>[]
  >,
  target?: AtlasResourceManifest,
): unknown {
  const relation = field.relation;

  if (relation === undefined || value === null || value === undefined) {
    return value;
  }

  const targetRecords = recordsByResource.get(relation.resource) ?? [];
  const resolveOne = (identifier: unknown) => {
    const record = targetRecords.find((candidate) =>
      serializeIdentifier(target === undefined
        ? undefined
        : candidate[target.identity])
      === serializeIdentifier(identifier));

    if (record === undefined) {
      return identifier;
    }

    return record[
      relation.displayField
      ?? target?.displayField
      ?? target?.identity
      ?? "id"
    ] ?? identifier;
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
    readonly Readonly<Record<string, unknown>>[]
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
  const values = relation.cardinality === "many" && Array.isArray(value)
    ? value
    : [value];

  return values.map((identifier) => {
    const record = targetRecords.find((candidate) =>
      serializeIdentifier(target === undefined
        ? undefined
        : candidate[target.identity])
      === serializeIdentifier(identifier));
    const targetIdentity = target === undefined || record === undefined
      ? undefined
      : record[target.identity];
    const fallbackIdentity = identifier;

    return {
      resourceId: relation.resource,
      ...(targetIdentity === undefined && fallbackIdentity === undefined
        ? {}
        : { recordId: String(targetIdentity ?? fallbackIdentity) }),
      label: record?.[
        relation.displayField
        ?? target?.displayField
        ?? target?.identity
        ?? "id"
      ]
        ?? identifier,
    };
  });
}

/** Executes one readMany Query per target Resource for the visible records. */
export function useRelationHydration(
  manifest: AtlasManifest,
  resource: AtlasResourceManifest,
  records: readonly Readonly<Record<string, unknown>>[],
) {
  const requests = createRelationHydrationRequests(
    manifest,
    resource,
    records,
  );
  const queries = useQueries({
    queries: requests.map((request) => ({
      queryKey: [request.resource.id, "readMany", request.ids],
      queryFn: async () => {
        const result = await executeAtlasOperation(
          manifest.basePath,
          request.resource.capabilities.readMany,
          { ids: request.ids },
        );

        if (!Array.isArray(result)) {
          throw new TypeError(
            "The Resource readMany operation returned an invalid result.",
          );
        }

        return result.filter(isRecord);
      },
    })),
  });
  const recordsByResource = new Map(
    requests.map((request, index) => [
      request.resource.id,
      queries[index]?.data ?? [],
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
  return `${typeof identifier}:${JSON.stringify(identifier)}`;
}
