import { describe, expect, it } from "vitest";
import { defineAtlas } from "./atlas.js";
import { validateAtlasAppearance } from "./appearance.js";

describe("Atlas appearance", () => {
  it("snapshots serializable branding and theme into the manifest", () => {
    const branding = { logo: { src: "/symbol.svg", darkSrc: "/symbol-dark.svg", alt: "Example" } };
    const theme = { primaryColor: "#07586a" };
    const atlas = defineAtlas({ resources: [], branding, theme });
    branding.logo.src = "/changed.svg";
    theme.primaryColor = "#ffffff";
    expect(atlas.getManifest()).toMatchObject({
      branding: { logo: { src: "/symbol.svg", darkSrc: "/symbol-dark.svg", alt: "Example" } },
      theme: { primaryColor: "#07586a" },
    });
    expect(defineAtlas({ resources: [] }).getManifest()).not.toHaveProperty("theme");
  });

  it.each(["javascript:alert(1)", "//example.com/logo.svg", "", "https://example.com/\\logo.svg"])("rejects unsafe logo URL %s", (src) => {
    expect(() => validateAtlasAppearance({ logo: { src, alt: "Example" } })).toThrow();
  });

  it("rejects invalid colors, unknown roles and empty alternative text", () => {
    expect(() => defineAtlas({ resources: [], theme: { primaryColor: "red; color: blue" } })).toThrow();
    expect(() => validateAtlasAppearance(undefined, { dark: { colors: { primary: "#fff" } } })).toThrow();
    expect(() => validateAtlasAppearance(undefined, { light: { colors: { unknown: "#ffffff" } } } as never)).toThrow();
    expect(() => validateAtlasAppearance({ logo: { src: "/logo.svg", alt: " " } })).toThrow();
  });
});
