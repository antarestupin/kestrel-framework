/** Serializable visual identity shared by server definitions and browser delivery. */
export interface AtlasBrandingOptions {
  readonly logo?: {
    readonly src: string;
    readonly alt: string;
    readonly darkSrc?: string;
  };
}

/** Semantic roles map to the stable Atlas CSS custom properties. */
export const atlasColorProperties = {
  background: "--atlas-background",
  surface: "--atlas-surface",
  surfaceSubtle: "--atlas-surface-subtle",
  surfaceAccent: "--atlas-surface-accent",
  surfaceAccentHover: "--atlas-surface-accent-hover",
  border: "--atlas-border",
  borderStrong: "--atlas-border-strong",
  heading: "--atlas-heading",
  text: "--atlas-text",
  textControl: "--atlas-text-control",
  textMuted: "--atlas-text-muted",
  textSubtle: "--atlas-text-subtle",
  textFaint: "--atlas-text-faint",
  primary: "--atlas-accent",
  primaryStrong: "--atlas-accent-strong",
  accentBorder: "--atlas-accent-border",
  dangerSurface: "--atlas-danger-surface",
  dangerBorder: "--atlas-danger-border",
  dangerText: "--atlas-danger-text",
  successSurface: "--atlas-success-surface",
  successText: "--atlas-success-text",
  overlay: "--atlas-overlay",
  shadow: "--atlas-shadow",
  onPrimary: "--atlas-on-primary",
  primaryHover: "--atlas-primary-hover",
  sidebarBackground: "--atlas-sidebar-background",
  sidebarText: "--atlas-sidebar-text",
  sidebarHeading: "--atlas-sidebar-heading",
  sidebarMuted: "--atlas-sidebar-muted",
  sidebarBorder: "--atlas-sidebar-border",
  sidebarHover: "--atlas-sidebar-hover",
  sidebarActiveText: "--atlas-sidebar-active-text",
  sidebarAccent: "--atlas-sidebar-accent",
  logoBackground: "--atlas-logo-background",
  logoText: "--atlas-logo-text",
} as const;

export type AtlasColors = Partial<Record<keyof typeof atlasColorProperties, string>>;

export interface AtlasThemeOptions {
  readonly primaryColor?: string;
  readonly light?: { readonly colors?: AtlasColors };
  readonly dark?: { readonly colors?: AtlasColors };
}

/** Reject invalid values before they can reach browser styles or image URLs. */
export function validateAtlasAppearance(branding?: AtlasBrandingOptions, theme?: AtlasThemeOptions): void {
  const logo = branding?.logo;
  if (logo) {
    for (const src of [logo.src, logo.darkSrc].filter((value) => value !== undefined)) {
      if (!/^(\/(?!\/)|https:\/\/)/.test(src!) || /[\s\\<>"']/.test(src!)) {
        throw new TypeError("Atlas logo URLs must be root-relative or HTTPS URLs.");
      }
    }
    if (!logo.alt.trim()) throw new TypeError("Atlas logo alternative text cannot be empty.");
  }
  const colors = [theme?.primaryColor];
  for (const scheme of [theme?.light, theme?.dark]) {
    for (const [key, value] of Object.entries(scheme?.colors ?? {})) {
      if (!Object.hasOwn(atlasColorProperties, key)) throw new TypeError(`Unknown Atlas color: ${key}`);
      colors.push(value);
    }
  }
  for (const color of colors) {
    if (color !== undefined && !/^#[\da-f]{6}$/i.test(color)) {
      throw new TypeError("Atlas colors must use six-digit hexadecimal notation.");
    }
  }
}
