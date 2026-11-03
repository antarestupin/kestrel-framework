import { useInfiniteQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { AtlasResourceManifest } from "../../contract.js";
import { atlasHistoryOutputSchema, type AtlasHistoryPage } from "../../history.js";
import { executeAtlasOperation } from "./runtime.js";

/** A sparse matrix deliberately leaves unchanged values blank. */
export function HistoryMatrix({ basePath, resource, recordId }: {
  basePath: string;
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
      basePath, resource.capabilities.history!,
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
        <HistoryTable resource={resource} fields={fields} events={events} />
      </div>
    </> : null}
  </details>;
}

/** Pure table renderer shared by the paginated panel and presentation tests. */
export function HistoryTable({ resource, fields, events }: {
  resource: AtlasResourceManifest;
  fields: readonly string[];
  events: AtlasHistoryPage["events"];
}) {
  return (
        <table className="history-matrix" aria-label="Resource history">
          <thead><tr><th scope="col">Field</th>{events.map((event) => <th scope="col" key={event.sequence}>
            <time dateTime={event.changedAt}>{new Date(event.changedAt).toLocaleString()}</time>
            <div>{event.operation} · #{event.sequence}</div>
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
              ? <pre>{event.values[id] === null ? "NULL" : event.values[id] === "" ? '\"\"' : typeof event.values[id] === "string" ? event.values[id] as string : JSON.stringify(event.values[id], null, 2)}</pre>
              : null}</td>)}
          </tr>)}</tbody>
        </table>
  );
}
