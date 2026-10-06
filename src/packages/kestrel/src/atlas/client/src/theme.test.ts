import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAtlasTheme,
  ATLAS_THEME_STORAGE_KEY,
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
    expect(window.localStorage.getItem).toHaveBeenCalledWith(
      ATLAS_THEME_STORAGE_KEY,
    );
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
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    applyAtlasTheme("system");

    expect(documentElement).toEqual({
      dataset: { theme: "dark" },
      style: { colorScheme: "dark" },
    });
  });
});
