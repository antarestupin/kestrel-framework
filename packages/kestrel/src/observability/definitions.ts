/** JSON values accepted by observation payloads and PostgreSQL storage. */
export type ObservationValue =
  | boolean
  | null
  | number
  | string
  | readonly ObservationValue[]
  | { readonly [key: string]: ObservationValue };

export type ObservationData = Readonly<Record<string, ObservationValue>>;

/**
 * Describes one stable observation contract emitted by Kestrel code.
 *
 * The optional data member only carries the payload type through TypeScript;
 * it is never materialized on a definition at runtime.
 */
export interface ObservationDefinition<Data extends ObservationData> {
  readonly name: string;
  readonly category: string;
  readonly schemaVersion: number;
  readonly data?: Data;
}

export type ObservationDefinitionData<
  Definition extends ObservationDefinition<ObservationData>,
> = NonNullable<Definition["data"]>;

/** Defines a typed observation without coupling producers to its storage. */
export function defineObservation<
  Data extends ObservationData,
>(definition: {
  name: string;
  category: string;
  schemaVersion?: number;
}): ObservationDefinition<Data> {
  return {
    name: definition.name,
    category: definition.category,
    schemaVersion: definition.schemaVersion ?? 1,
  };
}
