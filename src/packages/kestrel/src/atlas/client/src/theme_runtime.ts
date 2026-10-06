export const ATLAS_THEME_STORAGE_KEY = "atlas-theme";

export type AtlasTheme = "light" | "dark" | "system";

export const ATLAS_THEMES: readonly AtlasTheme[] = [
  "light",
  "dark",
  "system",
];

/** Reads a valid preference while gracefully handling unavailable browser storage. */
export function readAtlasTheme(): AtlasTheme {
  try {
    const storedTheme = window.localStorage.getItem(
      ATLAS_THEME_STORAGE_KEY,
    );

    return ATLAS_THEMES.includes(storedTheme as AtlasTheme)
      ? storedTheme as AtlasTheme
      : "system";
  } catch {
    return "system";
  }
}

/** Applies the effective color scheme before React renders to avoid a theme flash. */
export function applyAtlasTheme(theme: AtlasTheme): void {
  const resolvedTheme = theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;

  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
}

/** Initializes the document theme as early as possible during client startup. */
export function initializeAtlasTheme(): void {
  applyAtlasTheme(readAtlasTheme());
}
