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

  it("installs styles before rendering without changing theme preference storage", () => {
    const style = { dataset: {}, textContent: "" };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => style, head: { append } });
    initializeAtlasAppearance({ primaryColor: "#07586a" });
    expect(append).toHaveBeenCalledWith(style);
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
