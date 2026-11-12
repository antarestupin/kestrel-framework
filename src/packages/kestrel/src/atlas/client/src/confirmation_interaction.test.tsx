// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { AtlasConfirmationProvider, useAtlasConfirmation } from "./confirmation.js";

it("cancels a pending confirmation if its provider is removed", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const finished = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });

  function Trigger() {
    const confirm = useAtlasConfirmation();
    return <button type="button" onClick={() => {
      void confirm({ title: "Archive item", description: "Move this record to the archive." }).then(finished);
    }}>Archive</button>;
  }

  try {
    await act(async () => root.render(<AtlasConfirmationProvider><Trigger /></AtlasConfirmationProvider>));
    await act(async () => host.querySelector("button")!.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Archive item");
    expect(finished).not.toHaveBeenCalled();

    await act(async () => root.render(null));
    expect(finished).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      host.remove();
      vi.unstubAllGlobals();
    }
  }
});
