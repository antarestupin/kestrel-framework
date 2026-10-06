import { useEffect, useState } from "react";

import { Menu } from "./ui/primitives.js";
import {
  applyAtlasTheme,
  ATLAS_THEME_STORAGE_KEY,
  readAtlasTheme,
  type AtlasTheme,
  ATLAS_THEMES,
} from "./theme_runtime.js";

/** Lets users choose a persistent theme from Atlas sidebar. */
export function AtlasThemeSelector() {
  const [theme, setTheme] = useState<AtlasTheme>(readAtlasTheme);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => {
      if (theme === "system") {
        applyAtlasTheme(theme);
      }
    };

    applyAtlasTheme(theme);
    systemTheme.addEventListener("change", updateSystemTheme);

    return () => systemTheme.removeEventListener("change", updateSystemTheme);
  }, [theme]);

  const selectTheme = (selectedTheme: AtlasTheme) => {
    setTheme(selectedTheme);

    try {
      window.localStorage.setItem(
        ATLAS_THEME_STORAGE_KEY,
        selectedTheme,
      );
    } catch {
      // The active choice still applies when storage is disabled or unavailable.
    }
  };

  return (
    <div className="theme-selector">
      <Menu.Root>
        <Menu.Trigger className="theme-selector-trigger">
          <span>Theme</span>
          <strong>{formatTheme(theme)}</strong>
        </Menu.Trigger>
        <Menu.Portal keepMounted>
          <Menu.Positioner
            align="start"
            className="theme-menu-positioner"
            side="right"
            sideOffset={8}
          >
            <Menu.Popup className="theme-menu-list">
              <Menu.RadioGroup
                onValueChange={(value) => selectTheme(value as AtlasTheme)}
                value={theme}
              >
                {ATLAS_THEMES.map((themeOption) => (
                  <Menu.RadioItem
                    className="theme-menu-item"
                    key={themeOption}
                    value={themeOption}
                  >
                    <Menu.RadioItemIndicator className="theme-menu-indicator">
                      ✓
                    </Menu.RadioItemIndicator>
                    {formatTheme(themeOption)}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function formatTheme(theme: AtlasTheme): string {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}
