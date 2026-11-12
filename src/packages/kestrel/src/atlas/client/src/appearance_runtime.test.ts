import { afterEach, describe, expect, it, vi } from "vitest";
import { atlasAppearanceCss, initializeAtlasAppearance, initializeAtlasFavicon } from "./appearance_runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("Atlas appearance styles", () => {
  it("retains defaults and scopes partial overrides to the requested scheme", () => {
    expect(atlasAppearanceCss()).not.toContain("--atlas-");
    expect(atlasAppearanceCss({ light: { colors: { sidebarBackground: "#123638" } } }))
      .toBe(':root[data-theme="light"]{--atlas-sidebar-background:#123638}\n:root[data-theme="dark"]{}');
  });

  it("derives both palettes and contrasting control text from a primary color", () => {
    const css = atlasAppearanceCss({ primaryColor: "#000000", dark: { colors: { primary: "#ffffff", background: "#101b1c" } } });
    const [light, dark] = css.split("\n");
    expect(light).toContain("--atlas-accent:#000000");
    expect(light).toContain("--atlas-on-primary:#ffffff");
    expect(dark).toContain("--atlas-accent:#ffffff");
    expect(dark).toContain("--atlas-on-primary:#000000");
    expect(dark).toContain("--atlas-background:#101b1c");
    expect(css).toContain("--atlas-surface-accent:");
    expect(css).toContain("--atlas-primary-hover:");
  });

  it("keeps hover contrast for mid-tone primary controls", () => {
    const css = atlasAppearanceCss({ primaryColor: "#808080" });
    expect(css).toContain("--atlas-on-primary:#000000");
    expect(css).toContain("--atlas-primary-hover:#939393");
  });

  it("derives distinct accent, border, hover and logo roles for each configured scheme", () => {
    const [light, dark] = atlasAppearanceCss({ primaryColor: "#176b70" }).split("\n");
    const expectedLight = [
      "--atlas-accent:#176b70", "--atlas-accent-strong:#12565a", "--atlas-primary-hover:#145b5f",
      "--atlas-on-primary:#ffffff", "--atlas-accent-border:#97bcbf", "--atlas-surface-accent:#e8f0f1",
      "--atlas-surface-accent-hover:#f1f6f6", "--atlas-sidebar-accent:#8bb5b8",
      "--atlas-logo-background:#176b70", "--atlas-logo-text:#ffffff",
    ];
    const expectedDark = [
      "--atlas-accent:#74a6a9", "--atlas-accent-strong:#90b8ba", "--atlas-primary-hover:#89b3b6",
      "--atlas-on-primary:#000000", "--atlas-accent-border:#405a61", "--atlas-surface-accent:#1f2933",
      "--atlas-surface-accent-hover:#1c232e", "--atlas-sidebar-accent:#74a6a9",
      "--atlas-logo-background:#74a6a9", "--atlas-logo-text:#000000",
    ];
    expect(light).toBe(`:root[data-theme="light"]{${expectedLight.join(";")}}`);
    expect(dark).toBe(`:root[data-theme="dark"]{${expectedDark.join(";")}}`);
  });

  it.each(["#006dfb", "#0003fd", "#0056ff"])("chooses white text for saturated primary color %s", (primary) => {
    const [light] = atlasAppearanceCss({ primaryColor: primary }).split("\n");
    expect(light).toContain("--atlas-on-primary:#ffffff");
  });

  it("installs styles before rendering without changing theme preference storage", () => {
    const style = { dataset: {}, textContent: "" };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => style, head: { append } });
    initializeAtlasAppearance({ primaryColor: "#07586a" });
    expect(append).toHaveBeenCalledWith(style);
    expect(style.dataset).toEqual({ atlasAppearance: "" });
    expect(style.textContent).toContain("--atlas-accent:#07586a");
  });
});

// The initial logo URL is available before either React screen renders.
it("uses the logo as favicon and retains the optional dark variant", () => {
  const icon = { dataset: {}, rel: "", href: "" };
  const append = vi.fn();
  vi.stubGlobal("document", { createElement: () => icon, head: { append } });
  initializeAtlasFavicon({ logo: { src: "/logo.svg", alt: "Example", darkSrc: "/dark.svg" } });
  expect(icon).toMatchObject({ rel: "icon", href: "/logo.svg", dataset: { atlasFavicon: "/logo.svg", atlasDarkFavicon: "/dark.svg" } });
  expect(append).toHaveBeenCalledOnce();
});

it("does not install a favicon without a configured logo", () => {
  const append = vi.fn();
  vi.stubGlobal("document", { head: { append } });
  initializeAtlasFavicon();
  expect(append).not.toHaveBeenCalled();
});
