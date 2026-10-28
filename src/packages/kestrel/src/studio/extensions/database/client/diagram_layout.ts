import { useEffect, useRef, useState } from "react";

import type { StudioDatabaseLayout } from "../contract.js";
import { createDatabaseDiagramLayout } from "../schema_layout.js";

/** Repack measured HTML content while keeping table widths independent of the viewport. */
export function useDatabaseDiagramLayout(layout: StudioDatabaseLayout) {
  const canvas = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<Record<string, number>>({});
  const diagram = createDatabaseDiagramLayout(layout, {
    minimumTableWidth: 300,
    tableWidthExtra: 40,
    tableHeaderHeight: 28,
    rowHeight: 23,
    groupHeaderHeight: 44,
    measurements,
  });

  useEffect(() => {
    const root = canvas.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    const elements = root.querySelectorAll<HTMLElement>("[data-database-measure]");
    const measure = () => {
      const next: Record<string, number> = {};
      for (const element of elements) {
        next[element.dataset.databaseMeasure!] = Math.ceil(element.getBoundingClientRect().height);
      }
      // Avoid render loops when repacking only changes element positions.
      setMeasurements((current) => Object.keys(next).length === Object.keys(current).length
        && Object.entries(next).every(([key, value]) => current[key] === value) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    for (const element of elements) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [layout]);

  return { canvas, diagram };
}
