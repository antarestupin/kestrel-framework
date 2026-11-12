// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtlasClientEffect, AtlasManifest, AtlasOperationResponse } from "../../contract.js";
import { AtlasEffectProvider, useAtlasActionFeedback, useAtlasEffects } from "./effects.js";

const operation = { id: "record.read", sourceId: "app", effect: "read", inputs: [] } as const;
const manifest: AtlasManifest = {
  basePath: "/atlas",
  title: "Atlas",
  defaults: { textMaxLength: 50, recordActionsInList: "all" },
  icons: {},
  notifications: { position: "bottom-left" },
  resources: [{
    id: "items", label: "Items", labelSingular: "Item", identity: "id", displayField: "id", sourceId: "app",
    fields: [], capabilities: { list: operation, read: operation, readMany: operation }, recordActions: [], views: [],
  }],
};

function Trigger({ execute, effects = [] }: {
  execute: () => Promise<AtlasOperationResponse>;
  effects?: readonly AtlasClientEffect[];
}) {
  const track = useAtlasActionFeedback();
  const publish = useAtlasEffects();
  return <>
    <button type="button" onClick={() => void track(execute(), { label: "Archive" }).catch(() => {})}>Run action</button>
    <button type="button" onClick={() => publish(effects)}>Publish effects</button>
  </>;
}

describe("Atlas notifications", () => {
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

  async function click(text: string) {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
    if (button === undefined) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  }

  it("updates pending action feedback with server messages and safe record links", async () => {
    const action = Promise.withResolvers<AtlasOperationResponse>();
    await act(async () => root.render(<AtlasEffectProvider manifest={manifest}>
      <Trigger execute={() => action.promise} />
    </AtlasEffectProvider>));
    await click("Run action");
    expect(document.body.textContent).toContain("Running “Archive”");

    const target = { resource: "items", recordId: "group/42" };
    await act(async () => action.resolve({
      data: null,
      effects: [
        { type: "redirect", target },
        { type: "notification", level: "success", message: "Archived", link: { label: "Open item", target } },
        { type: "notification", level: "error", message: "Follow-up failed" },
      ],
    }));
    expect(document.body.textContent).toContain("Archived");
    expect(document.body.textContent).toContain("Follow-up failed");
    expect(document.body.textContent).not.toContain("Running “Archive”");
    expect(document.querySelector(".notification a")?.getAttribute("href")).toBe("/atlas/items/group%2F42");
  });

  it("shows action failures and keeps an unlinkable notification visible", async () => {
    const action = Promise.withResolvers<AtlasOperationResponse>();
    await act(async () => root.render(<AtlasEffectProvider manifest={manifest}>
      <Trigger execute={() => action.promise} effects={[
        { type: "notification", level: "info", message: "Saved to another workspace", link: {
          label: "Open item", target: { resource: "hidden", recordId: "42" },
        } },
      ]} />
    </AtlasEffectProvider>));
    await click("Run action");
    await act(async () => action.reject(new Error("offline")));
    expect(document.body.textContent).toContain("“Archive” failed.");
    await click("Publish effects");
    expect(document.body.textContent).toContain("Saved to another workspace");
    expect(document.querySelector(".notification a")).toBeNull();
  });
});
