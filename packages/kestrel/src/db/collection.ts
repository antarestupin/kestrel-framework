import type { PagePagination } from "./pagination.js";

/** Operators understood by conventional application collection queries. */
export type CollectionFilterOperator =
  | "contains"
  | "equals"
  | "greater-than"
  | "greater-than-or-equal"
  | "in"
  | "is-not-null"
  | "is-null"
  | "less-than"
  | "less-than-or-equal"
  | "not-equals"
  | "not-in"
  | "starts-with";

export interface CollectionFilter {
  readonly field: string;
  readonly operator: CollectionFilterOperator;
  readonly value?: unknown | undefined;
}

export interface CollectionSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** Catalog-facing collection contract kept independent from interface DTOs. */
export interface CollectionQuery {
  readonly pagination: PagePagination;
  readonly search?: { readonly term: string } | undefined;
  readonly filters?: readonly CollectionFilter[] | undefined;
  readonly sort?: readonly CollectionSort[] | undefined;
}

export interface RepositoryCollectionOptions {
  /** Columns combined with OR for a case-insensitive text search. */
  readonly search?: Readonly<Record<string, unknown>>;
  /** Fields and operators accepted by the repository query compiler. */
  readonly filters?: Readonly<Record<
    string,
    {
      readonly column: unknown;
      readonly operators: readonly CollectionFilterOperator[];
    }
  >>;
  /** Columns accepted in caller-provided sorting criteria. */
  readonly sorting?: Readonly<Record<string, unknown>>;
}
