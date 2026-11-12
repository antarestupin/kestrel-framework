// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { FieldValue } from "./field_value.js";

it("opens a relation in Atlas for a plain click and preserves browser shortcuts", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const prevented: boolean[] = [];
  // Observe React's decision, then prevent jsdom from navigating away.
  const stopNavigation = (event: MouseEvent) => {
    prevented.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", stopNavigation);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  try {
    const properties = {
      basePath: "/atlas",
      field: { id: "owner", kind: "relation", label: "Owner", schema: {}, hidden: false,
        readOnly: true, searchable: false, sortable: false, filterOperators: [] },
      relationReferences: [{ resourceId: "users", recordId: "team/42", label: "Owner" }],
      value: "team/42",
    } as const;
    await act(async () => root.render(<FieldValue {...properties} onOpenRelation={open} />));
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/atlas/users/team%2F42");
    await act(async () => {
      for (const shortcut of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, {}]) {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...shortcut }));
      }
    });
    expect(prevented).toEqual([false, false, false, false, false, true]);
    expect(open).toHaveBeenCalledExactlyOnceWith("users", "team/42");

    await act(async () => root.render(<FieldValue {...properties} />));
    await act(async () => host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(prevented.at(-1)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    document.removeEventListener("click", stopNavigation);
    host.remove();
    vi.unstubAllGlobals();
  }
});
