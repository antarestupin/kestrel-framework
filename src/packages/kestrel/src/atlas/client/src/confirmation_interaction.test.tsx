// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AtlasConfirmationProvider, useAtlasConfirmation } from "./confirmation.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("cancels a pending confirmation if its provider is removed", async () => {
  const finished = vi.fn();

  function Trigger() {
    const confirm = useAtlasConfirmation();
    return <button type="button" onClick={() => {
      void confirm({ title: "Archive item", description: "Move this record to the archive." }).then(finished);
    }}>Archive</button>;
  }

  await act(async () => root.render(<AtlasConfirmationProvider><Trigger /></AtlasConfirmationProvider>));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => host.querySelector("button")!.click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Archive item");
  expect(finished).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  expect(finished).toHaveBeenCalledExactlyOnceWith(false);
});

it("resolves the superseded request and settles the replacement only once", async () => {
  const first = vi.fn();
  const second = vi.fn();

  function Trigger() {
    const confirm = useAtlasConfirmation();
    return <button type="button" onClick={() => {
      // The first caller must be released even when both request in the same event.
      void confirm({ title: "Archive item", description: "Move it to the archive." }).then(first);
      void confirm({ title: "Save item", description: "Store the current values." }).then(second);
    }}>Ask twice</button>;
  }

  await act(async () => root.render(<AtlasConfirmationProvider><Trigger /></AtlasConfirmationProvider>));
  await act(async () => host.querySelector("button")!.click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Save item");
  expect(dialog.textContent).toContain("Store the current values.");
  expect(first).toHaveBeenCalledExactlyOnceWith(false);
  expect(second).not.toHaveBeenCalled();
  const accept = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Confirm")!;
  expect(accept.classList.contains("primary")).toBe(true);
  await act(async () => {
    accept.click();
    accept.click();
  });
  expect(second).toHaveBeenCalledExactlyOnceWith(true);
});

it("declines confirmations when no surface is installed", async () => {
  const finished = vi.fn();
  function Trigger() {
    const confirm = useAtlasConfirmation();
    return <button type="button" onClick={() => {
      void confirm({ title: "Delete item", description: "This cannot be undone." }).then(finished);
    }}>Delete</button>;
  }

  await act(async () => root.render(<Trigger />));
  await act(async () => host.querySelector("button")!.click());
  expect(finished).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
