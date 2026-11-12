// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { AtlasThemeSelector } from "./theme.js";
import { ATLAS_THEME_STORAGE_KEY } from "./theme_runtime.js";

it("follows the OS until the user chooses and persists an explicit theme", async () => {
  const preference = Object.assign(new EventTarget(), { matches: false });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => preference);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.localStorage.removeItem(ATLAS_THEME_STORAGE_KEY);

  try {
    await act(async () => root.render(<AtlasThemeSelector />));
    const trigger = host.querySelector("button")!;
    expect(trigger.textContent).toContain("System");
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => {
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");

    await act(async () => trigger.click());
    const light = [...document.querySelectorAll('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("Light"));
    expect(light).toBeInstanceOf(HTMLElement);
    await act(async () => (light as HTMLElement).click());
    expect(window.localStorage.getItem(ATLAS_THEME_STORAGE_KEY)).toBe("light");
    expect(trigger.textContent).toContain("Light");

    await act(async () => preference.dispatchEvent(new Event("change")));
    expect(document.documentElement.dataset.theme).toBe("light");
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      host.remove();
      window.localStorage.removeItem(ATLAS_THEME_STORAGE_KEY);
      delete document.documentElement.dataset.theme;
      document.documentElement.style.removeProperty("color-scheme");
      vi.unstubAllGlobals();
    }
  }
});
