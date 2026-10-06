import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  AtlasCollectionQuery,
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationInputManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import { Combobox } from "./ui/primitives.js";
import {
  executeAtlasOperation,
  isRecord,
  readListResult,
} from "./runtime.js";

const DEFAULT_LOOKUP_PAGE_SIZE = 20;
const LOOKUP_DEBOUNCE_MILLISECONDS = 250;

export interface RelationInputProperties {
  readonly definition: AtlasOperationInputManifest;
  readonly field: AtlasFieldManifest;
  readonly manifest: AtlasManifest;
  readonly value?: unknown;
}

/** Builds the bounded first-page request shared by default and custom lookups. */
export function createRelationLookupQuery(
  field: AtlasFieldManifest,
  search: string,
): AtlasCollectionQuery | undefined {
  const trimmedSearch = search.trim();
  const minimumSearchLength = field.relation?.lookup?.minimumSearchLength ?? 0;

  if (trimmedSearch.length < minimumSearchLength) {
    return undefined;
  }

  return {
    pagination: {
      type: "page",
      page: 1,
      pageSize: field.relation?.lookup?.pageSize ?? DEFAULT_LOOKUP_PAGE_SIZE,
    },
    ...(trimmedSearch === "" ? {} : { search: trimmedSearch }),
  };
}

/** Returns the identity and label rendered for one lookup result. */
export function getRelationCandidate(
  target: AtlasResourceManifest,
  field: AtlasFieldManifest,
  record: Readonly<Record<string, unknown>>,
): { readonly identity: unknown; readonly label: string } | undefined {
  const identity = record[target.identity];

  if (identity === undefined || identity === null) {
    return undefined;
  }

  const displayField = field.relation?.displayField ?? target.displayField;
  const displayValue = record[displayField];

  return {
    identity,
    label: displayValue === undefined || displayValue === null || displayValue === ""
      ? String(identity)
      : String(displayValue),
  };
}

/** Standard relation picker backed by the target list or an explicit lookup. */
export function RelationInput({
  definition,
  field,
  manifest,
  value,
}: RelationInputProperties) {
  const relation = field.relation;
  const target = manifest.resources.find((resource) =>
    resource.id === relation?.resource);
  const [mode, setMode] = useState<"autocomplete" | "identifier">(
    "autocomplete",
  );
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<readonly unknown[]>(() =>
    normalizeRelationIdentifiers(value, relation?.cardinality ?? "one"));
  const [directValue, setDirectValue] = useState(() =>
    formatDirectIdentifiers(selected, relation?.cardinality ?? "one"));

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search),
      LOOKUP_DEBOUNCE_MILLISECONDS,
    );

    return () => window.clearTimeout(timeout);
  }, [search]);

  const searchable = target?.fields.some((candidate) => candidate.searchable)
    ?? false;
  const lookupQuery = createRelationLookupQuery(
    field,
    searchable ? debouncedSearch : "",
  );
  const lookupOperation = relation?.lookup?.operation
    ?? target?.capabilities.list;
  const candidatesQuery = useQuery({
    queryKey: [
      target?.id,
      "relation-lookup",
      lookupOperation?.id,
      lookupQuery,
    ],
    queryFn: async () => readListResult(await executeAtlasOperation(
      manifest.basePath,
      lookupOperation!,
      { ...lookupQuery! },
    )),
    enabled: mode === "autocomplete"
      && open
      && target !== undefined
      && lookupOperation !== undefined
      && lookupQuery !== undefined,
  });
  const selectedRecordsQuery = useQuery({
    queryKey: [target?.id, "relation-input", selected],
    queryFn: async () => {
      const result = await executeAtlasOperation(
        manifest.basePath,
        target!.capabilities.readMany,
        { ids: selected },
      );

      return Array.isArray(result) ? result.filter(isRecord) : [];
    },
    enabled: target !== undefined && selected.length > 0,
  });
  const selectedLabels = useMemo(() => new Map(
    (selectedRecordsQuery.data ?? []).flatMap((record) => {
      const candidate = target === undefined
        ? undefined
        : getRelationCandidate(target, field, record);

      return candidate === undefined
        ? []
        : [[serializeIdentifier(candidate.identity), candidate.label] as const];
    }),
  ), [field, selectedRecordsQuery.data, target]);
  const candidates = (candidatesQuery.data?.items ?? []).flatMap((record) => {
    const candidate = target === undefined
      ? undefined
      : getRelationCandidate(target, field, record);

    return candidate === undefined ? [] : [candidate];
  });
  const cardinality = relation?.cardinality ?? "one";
  const parsedDirectIdentifiers = parseDirectIdentifiers(
    directValue,
    cardinality,
  );
  const submitted = mode === "identifier" ? parsedDirectIdentifiers : selected;
  const selectedKeys = selected.map(serializeIdentifier);
  const candidatesByKey = new Map(candidates.map((candidate) => [
    serializeIdentifier(candidate.identity),
    candidate,
  ]));
  const candidateKeys = [...candidatesByKey.keys()];
  const getLabel = (key: string) => candidatesByKey.get(key)?.label
    ?? selectedLabels.get(key)
    ?? key;
  const resolveIdentifiers = (keys: readonly string[]) => keys.flatMap((key) => {
    const candidate = candidatesByKey.get(key);
    const existing = selected.find((identifier) =>
      serializeIdentifier(identifier) === key);

    return candidate === undefined
      ? existing === undefined ? [] : [existing]
      : [candidate.identity];
  });

  if (relation === undefined || target === undefined) {
    return (
      <div className="error-state" role="alert">
        The relation target is unavailable.
      </div>
    );
  }

  const selectCandidates = (next: readonly unknown[]) => {
    setSelected(next);
    setDirectValue(formatDirectIdentifiers(next, cardinality));
    setSearch("");
  };

  const comboboxContent = (
    <>
      <Combobox.Input
        aria-label={field.label}
        onFocus={() => setOpen(true)}
        placeholder={searchable
          ? `Search ${target.label.toLocaleLowerCase()}…`
          : `Browse ${target.label.toLocaleLowerCase()}…`}
        readOnly={!searchable}
        type="search"
      />
      <Combobox.Portal>
        <Combobox.Positioner
          align="start"
          className="relation-input-positioner"
          side="bottom"
          sideOffset={4}
        >
          <Combobox.Popup className="relation-input-options">
            {lookupQuery === undefined ? (
              <p>Enter at least {relation.lookup?.minimumSearchLength} characters.</p>
            ) : candidatesQuery.isPending ? (
              <p>Loading…</p>
            ) : candidatesQuery.isError ? (
              <p role="alert">Candidate lookup failed.</p>
            ) : candidates.length === 0 ? (
              <p>No matching records.</p>
            ) : (
              <Combobox.List>
                {(key: string, index: number) => {
                  const candidate = candidatesByKey.get(key);

                  return candidate === undefined ? null : (
                    <Combobox.Item
                      className="relation-input-option"
                      disabled={cardinality === "many" && selectedKeys.includes(key)}
                      index={index}
                      key={key}
                      value={key}
                    >
                      <strong>{candidate.label}</strong>
                      <small>{String(candidate.identity)}</small>
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </>
  );

  return (
    <div className="form-field relation-input">
      <span>{field.label}{definition.required ? " *" : ""}</span>
      {submitted.map((identifier, index) => (
        <input
          key={`${serializeIdentifier(identifier)}-${index}`}
          name={definition.id}
          type="hidden"
          value={String(identifier)}
        />
      ))}
      {mode === "autocomplete" ? (
        <>
          {selected.length === 0 ? null : (
            <div className="relation-input-selection">
              {selected.map((identifier) => (
                <span className="relation-input-chip" key={serializeIdentifier(identifier)}>
                  {selectedLabels.get(serializeIdentifier(identifier))
                    ?? String(identifier)}
                  <button
                    aria-label={`Remove ${String(identifier)}`}
                    onClick={() => {
                      const next = selected.filter((item) =>
                        serializeIdentifier(item) !== serializeIdentifier(identifier));

                      setSelected(next);
                      setDirectValue(formatDirectIdentifiers(next, cardinality));
                    }}
                    type="button"
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <div className="relation-input-combobox">
            {cardinality === "many" ? (
              <Combobox.Root<string, true>
                autoComplete="none"
                filteredItems={candidateKeys}
                inputValue={search}
                itemToStringLabel={getLabel}
                multiple
                onInputValueChange={(nextSearch, eventDetails) => {
                  if (eventDetails.reason === "input-change"
                    || eventDetails.reason === "input-clear") {
                    setSearch(nextSearch);
                  }
                }}
                onOpenChange={setOpen}
                onValueChange={(keys) => selectCandidates(resolveIdentifiers(keys))}
                open={open}
                value={selectedKeys}
              >
                {comboboxContent}
              </Combobox.Root>
            ) : (
              <Combobox.Root<string>
                autoComplete="none"
                filteredItems={candidateKeys}
                inputValue={search}
                itemToStringLabel={getLabel}
                onInputValueChange={(nextSearch, eventDetails) => {
                  if (eventDetails.reason === "input-change"
                    || eventDetails.reason === "input-clear") {
                    setSearch(nextSearch);
                  }
                }}
                onOpenChange={setOpen}
                onValueChange={(key) => selectCandidates(
                  key === null ? [] : resolveIdentifiers([key]),
                )}
                open={open}
                value={selectedKeys[0] ?? null}
              >
                {comboboxContent}
              </Combobox.Root>
            )}
          </div>
        </>
      ) : cardinality === "many" ? (
        <textarea
          aria-label={`${field.label} identifiers`}
          onChange={(event) => setDirectValue(event.currentTarget.value)}
          rows={4}
          value={directValue}
        />
      ) : (
        <input
          aria-label={`${field.label} identifier`}
          onChange={(event) => setDirectValue(event.currentTarget.value)}
          required={definition.required}
          type="text"
          value={directValue}
        />
      )}
      <button
        className="relation-input-mode"
        onClick={() => {
          if (mode === "identifier") {
            setSelected(parsedDirectIdentifiers);
          } else {
            setDirectValue(formatDirectIdentifiers(selected, cardinality));
          }

          setMode(mode === "autocomplete" ? "identifier" : "autocomplete");
          setOpen(false);
        }}
        type="button"
      >
        {mode === "autocomplete"
          ? "Enter identifiers directly"
          : "Search records instead"}
      </button>
    </div>
  );
}

function normalizeRelationIdentifiers(
  value: unknown,
  cardinality: "many" | "one",
): readonly unknown[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  return cardinality === "many"
    ? Array.isArray(value) ? deduplicateIdentifiers(value) : []
    : [value];
}

function parseDirectIdentifiers(
  value: string,
  cardinality: "many" | "one",
): readonly string[] {
  if (cardinality === "one") {
    return value.trim() === "" ? [] : [value.trim()];
  }

  return deduplicateIdentifiers(
    value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
  ) as readonly string[];
}

function formatDirectIdentifiers(
  identifiers: readonly unknown[],
  cardinality: "many" | "one",
): string {
  return identifiers.map(String).join(cardinality === "many" ? "\n" : "");
}

function deduplicateIdentifiers(
  identifiers: readonly unknown[],
): readonly unknown[] {
  return [...new Map(identifiers.map((identifier) => [
    serializeIdentifier(identifier),
    identifier,
  ])).values()];
}

function serializeIdentifier(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}
