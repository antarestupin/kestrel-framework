import { useInfiniteQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { FieldValue } from "./field_value.js";
import { useRelationHydration } from "./relations.js";
import type { AtlasManifest, AtlasResourceManifest } from "../../contract.js";
import { atlasHistoryOutputSchema, type AtlasHistoryPage } from "../../history.js";
import { executeAtlasOperation } from "./runtime.js";

/** A sparse matrix deliberately leaves unchanged values blank. */
export function HistoryMatrix({ manifest, resource, recordId, onOpenRelation }: {
  manifest: AtlasManifest;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  resource: AtlasResourceManifest;
  recordId: string;
}) {
  const [open, setOpen] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const previousWidth = useRef(0);
  const history = useInfiniteQuery({
    queryKey: [resource.id, "history", recordId],
    initialPageParam: undefined as string | undefined,
    enabled: open,
    queryFn: async ({ pageParam }) => atlasHistoryOutputSchema.parse(await executeAtlasOperation(
      manifest.basePath, resource.capabilities.history!,
      { id: recordId, pageSize: 20, ...(pageParam === undefined ? {} : { before: pageParam }) },
    )),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const events = history.data?.pages.flatMap((page) => page.events).reverse() ?? [];
  const fields = history.data?.pages[0]?.fields ?? [];
  // Keep the current events visible when older columns are prepended.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) { previousWidth.current = 0; return; }
    element.scrollLeft += element.scrollWidth - previousWidth.current;
    previousWidth.current = element.scrollWidth;
  }, [events.length, open]);
  return <details className="history-panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>History</summary>
    {open ? <>
      {history.isPending ? <p role="status">Loading history…</p> : null}
      {history.isError ? <p role="alert">History could not be loaded. <button type="button" onClick={() => void history.refetch()}>Retry</button></p> : null}
      {history.hasNextPage ? <button type="button" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older changes</button> : null}
      {history.data && events.length === 0 ? <p>No history recorded.</p> : null}
      <div className="history-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Resource history">
        <HydratedHistoryTable manifest={manifest} resource={resource} fields={fields} events={events} onOpenRelation={onOpenRelation} />
      </div>
    </> : null}
  </details>;
}

/** Pure table renderer shared by the paginated panel and presentation tests. */
export function HistoryTable({ resource, fields, events, relations, basePath, onOpenRelation }: {
  relations?: ReturnType<typeof useRelationHydration>;
  basePath?: string;
  onOpenRelation?: (resourceId: string, recordId: string) => void;
  resource: AtlasResourceManifest;
  fields: readonly string[];
  events: AtlasHistoryPage["events"];
}) {
  return (
        <table className="history-matrix" aria-label="Resource history">
          <thead><tr><th scope="col">Field</th>{events.map((event) => <th scope="col" key={event.sequence}>
            <time dateTime={event.changedAt}>{new Date(event.changedAt).toLocaleString()}</time>
            {/* Sequence remains an internal event key and pagination cursor. */}
            <div>{event.operation}</div>
          </th>)}</tr></thead>
          {/* Event metadata stays visible and separate from sparse business changes. */}
          <tbody className="history-metadata">
            <tr>
              <th scope="row">Actor</th>
              {events.map((event) => <td key={event.sequence}>{event.actor ?? "Unknown"}</td>)}
            </tr>
            <tr>
              <th scope="row">Reason</th>
              {events.map((event) => <td key={event.sequence}>{event.reason ?? "Not provided"}</td>)}
            </tr>
          </tbody>
          <tbody>{fields.filter((id) => !resource.fields.find((field) => field.id === id)?.hidden).map((id) => <tr key={id}>
            <th scope="row">{resource.fields.find((field) => field.id === id)?.label ?? id}</th>
            {events.map((event) => <td key={event.sequence}>{Object.hasOwn(event.values, id)
              ? <HistoryValue resource={resource} id={id} value={event.values[id]} {...(relations === undefined ? {} : { relations })} {...(basePath === undefined ? {} : { basePath })} {...(onOpenRelation === undefined ? {} : { onOpenRelation })} />
              : null}</td>)}
          </tr>)}</tbody>
        </table>
  );
}

/** Hydrate only visible, allowlisted sparse values while the history panel is open. */
function HydratedHistoryTable(properties: {
  manifest: AtlasManifest;
  resource: AtlasResourceManifest;
  fields: readonly string[];
  events: AtlasHistoryPage["events"];
  onOpenRelation: (resourceId: string, recordId: string) => void;
}) {
  const { manifest, resource, fields, events } = properties;
  const relations = useRelationHydration(manifest, {
    ...resource, fields: resource.fields.filter((field) => fields.includes(field.id) && !field.hidden),
  }, events.map((event) => event.values));
  return <>
    {relations.error ? <p role="alert">Some related labels could not be loaded. Identifiers are shown instead.</p> : null}
    <HistoryTable {...properties} relations={relations} basePath={manifest.basePath} />
  </>;
}

/** Preserve sparse-history markers before delegating ordinary values to list renderers. */
function HistoryValue({ resource, id, value, relations, ...presentation }: {
  resource: AtlasResourceManifest;
  id: string;
  value: unknown;
  relations?: ReturnType<typeof useRelationHydration>;
  basePath?: string;
  onOpenRelation?: (resourceId: string, recordId: string) => void;
}) {
  if (value === null || value === "") return <pre>{value === null ? "NULL" : '\"\"'}</pre>;
  const field = resource.fields.find((candidate) => candidate.id === id);
  if (!field) return <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
  return <FieldValue {...presentation} resource={resource} field={field}
    value={relations?.resolve(field, value) ?? value}
    relationReferences={relations?.references(field, value) ?? []} />;
}
