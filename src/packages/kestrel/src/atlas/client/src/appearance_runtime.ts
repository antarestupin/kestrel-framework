import { atlasColorProperties, type AtlasThemeOptions, type AtlasColors, type AtlasBrandingOptions } from "../../appearance.js";

/** Blend in sRGB without adding a browser or server color dependency. */
function mix(color: string, target: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => Math.round(
    parseInt(color.slice(offset, offset + 2), 16) * (1 - amount)
    + parseInt(target.slice(offset, offset + 2), 16) * amount,
  ));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Choose the higher-contrast text color for filled primary controls. */
function foreground(color: string): string {
  const luminance = [1, 3, 5].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

/** Generate only configured roles; absent options retain the shipped Atlas palette. */
export function atlasAppearanceCss(theme?: AtlasThemeOptions): string {
  return (["light", "dark"] as const).map((mode) => {
    const overrides = theme?.[mode]?.colors ?? {};
    const configured = theme?.primaryColor;
    const primary = overrides.primary ?? (configured === undefined ? undefined
      : mode === "dark" ? mix(configured, "#ffffff", 0.4) : configured);
    const colors: AtlasColors = {};
    if (primary !== undefined) {
      const surface = mode === "dark" ? "#161b26" : "#ffffff";
      Object.assign(colors, {
        primary,
        primaryStrong: mix(primary, mode === "dark" ? "#ffffff" : "#000000", 0.2),
        // Move hover away from the chosen foreground to preserve contrast.
        primaryHover: mix(primary, foreground(primary) === "#000000" ? "#ffffff" : "#000000", 0.15),
        onPrimary: foreground(primary),
        accentBorder: mix(primary, surface, 0.55),
        surfaceAccent: mix(primary, surface, 0.9),
        surfaceAccentHover: mix(primary, surface, 0.94),
        sidebarAccent: mode === "dark" ? primary : mix(primary, "#ffffff", 0.5),
        logoBackground: primary,
        logoText: foreground(primary),
      });
    }
    Object.assign(colors, overrides);
    // An explicit primary override also receives a suitable default foreground.
    const declarations = Object.entries(colors).map(([key, value]) =>
      `${atlasColorProperties[key as keyof AtlasColors]}:${value}`,
    ).join(";");
    return `:root[data-theme="${mode}"]{${declarations}}`;
  }).join("\n");
}

/** Install once before React renders, including on unauthenticated login visits. */
export function initializeAtlasAppearance(theme?: AtlasThemeOptions): void {
  const style = document.createElement("style");
  style.dataset.atlasAppearance = "";
  style.textContent = atlasAppearanceCss(theme);
  document.head.append(style);
}

/** Reuse the configured logo as the document icon, including explicit theme choices. */
export function initializeAtlasFavicon(branding?: AtlasBrandingOptions): void {
  const logo = branding?.logo;
  if (logo === undefined) return;
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = logo.src;
  icon.dataset.atlasFavicon = logo.src;
  icon.dataset.atlasDarkFavicon = logo.darkSrc ?? logo.src;
  document.head.append(icon);
}
