import type {
  AtlasCollectionFilter,
  AtlasCollectionQuery,
  AtlasCollectionSort,
  AtlasFilterOperator,
} from "../../contract.js";

const DEFAULT_PAGE_SIZE = 20;
const filterOperators = new Set<AtlasFilterOperator>([
  "contains", "equals", "greater-than", "greater-than-or-equal", "in",
  "is-not-null", "is-null", "less-than", "less-than-or-equal",
  "not-equals", "not-in", "starts-with",
]);

/** Parses shareable URL state into the portable collection contract. */
export function parseAtlasCollectionSearch(
  search: Readonly<Record<string, unknown>>,
): AtlasCollectionQuery {
  const page = parsePositiveInteger(search.page) ?? 1;
  const pageSize = parsePositiveInteger(search.pageSize) ?? DEFAULT_PAGE_SIZE;
  const query = typeof search.q === "string" && search.q !== ""
    ? search.q
    : undefined;
  const filters = parseFilters(search.filters);
  const sorting = parseSorting(search.sort);

  return {
    pagination: { type: "page", page, pageSize },
    ...(query === undefined ? {} : { search: query }),
    ...(filters.length === 0 ? {} : { filters }),
    ...(sorting.length === 0 ? {} : { sorting }),
  };
}

/** Serializes collection state without leaking it into route components. */
export function serializeAtlasCollectionSearch(
  query: AtlasCollectionQuery,
): Readonly<Record<string, string | number | undefined>> {
  return {
    page: query.pagination.page === 1 ? undefined : query.pagination.page,
    pageSize: query.pagination.pageSize === DEFAULT_PAGE_SIZE
      ? undefined
      : query.pagination.pageSize,
    q: query.search === "" ? undefined : query.search,
    filters: query.filters === undefined || query.filters.length === 0
      ? undefined
      : JSON.stringify(query.filters),
    sort: query.sorting === undefined || query.sorting.length === 0
      ? undefined
      : query.sorting.map((item) => `${item.field}:${item.direction}`).join(","),
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value !== ""
      ? Number(value)
      : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFilters(value: unknown): readonly AtlasCollectionFilter[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed.flatMap((item) => isFilter(item) ? [item] : [])
      : [];
  } catch {
    return [];
  }
}

function isFilter(value: unknown): value is AtlasCollectionFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const filter = value as Record<string, unknown>;

  return typeof filter.field === "string"
    && typeof filter.operator === "string"
    && filterOperators.has(filter.operator as AtlasFilterOperator);
}

function parseSorting(value: unknown): readonly AtlasCollectionSort[] {
  if (typeof value !== "string") {
    return [];
  }

  return value.split(",").flatMap((item) => {
    const [field, direction, ...rest] = item.split(":");

    return rest.length === 0
        && field !== undefined
        && field !== ""
        && (direction === "asc" || direction === "desc")
      ? [{ field, direction }]
      : [];
  });
}
