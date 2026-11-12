import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAtlasTheme,
  ATLAS_THEME_STORAGE_KEY,
  initializeAtlasTheme,
  readAtlasTheme,
} from "./theme_runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atlas theme", () => {
  it("uses the stored theme when it is valid", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn().mockReturnValue("dark"),
      },
    });

    expect(readAtlasTheme()).toBe("dark");
    expect(ATLAS_THEME_STORAGE_KEY).toBe("atlas-theme");
    expect(window.localStorage.getItem).toHaveBeenCalledWith("atlas-theme");
  });

  it("falls back to the system theme for invalid or unavailable storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn().mockReturnValue("sepia"),
      },
    });

    expect(readAtlasTheme()).toBe("system");

    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("Storage disabled");
        }),
      },
    });

    expect(readAtlasTheme()).toBe("system");
  });

  it("resolves the system preference and updates the document scheme", () => {
    const documentElement = { dataset: {}, style: {} };
    vi.stubGlobal("document", { documentElement, querySelectorAll: () => [] });
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    applyAtlasTheme("system");

    expect(documentElement).toEqual({
      dataset: { theme: "dark" },
      style: { colorScheme: "dark" },
    });
    expect(window.matchMedia).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
  });

  it("applies the stored system choice before React starts", () => {
    const documentElement = { dataset: {}, style: {} };
    vi.stubGlobal("document", { documentElement, querySelectorAll: () => [] });
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn().mockReturnValue("system") },
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });
    initializeAtlasTheme();
    expect(documentElement).toEqual({ dataset: { theme: "light" }, style: { colorScheme: "light" } });
  });
});

it("updates the favicon when users explicitly switch the effective theme", () => {
  const icon = { href: "", dataset: { atlasFavicon: "/logo.svg", atlasDarkFavicon: "/dark.svg" } };
  vi.stubGlobal("document", {
    documentElement: { dataset: {}, style: {} }, querySelectorAll: () => [icon],
  });
  applyAtlasTheme("dark");
  expect(icon.href).toBe("/dark.svg");
  applyAtlasTheme("light");
  expect(icon.href).toBe("/logo.svg");
});
