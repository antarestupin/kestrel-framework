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
    expect(() => validateAtlasAppearance({ logo: { src, alt: "Example" } })).toThrow("Atlas logo URLs must be root-relative or HTTPS URLs.");
  });

  it("rejects invalid colors, unknown roles and empty alternative text", () => {
    expect(() => defineAtlas({ resources: [], theme: { primaryColor: "red; color: blue" } })).toThrow("six-digit hexadecimal notation");
    expect(() => validateAtlasAppearance(undefined, { dark: { colors: { primary: "#fff" } } })).toThrow("six-digit hexadecimal notation");
    expect(() => validateAtlasAppearance(undefined, { light: { colors: { constructor: "#ffffff" } } } as never)).toThrow("Unknown Atlas color: constructor");
    expect(() => validateAtlasAppearance({ logo: { src: "/logo.svg", alt: " " } })).toThrow("Atlas logo alternative text cannot be empty.");
    expect(() => validateAtlasAppearance(undefined, { primaryColor: "prefix#abcdef" })).toThrow("six-digit hexadecimal notation");
    expect(() => validateAtlasAppearance(undefined, { primaryColor: "#abcdefg" })).toThrow("six-digit hexadecimal notation");
  });

  it("accepts valid explicit branding and a one-character text limit", () => {
    const atlas = defineAtlas({
      resources: [], defaults: { textMaxLength: 1 },
      branding: { logo: { src: "https://example.test/logo.svg", alt: "Example", darkSrc: "/dark.svg" } },
      theme: { primaryColor: "#12AB34", dark: { colors: { sidebarBackground: "#223344" } } },
    });
    expect(atlas.getManifest().defaults.textMaxLength).toBe(1);
    expect(atlas.getManifest().theme?.dark?.colors?.sidebarBackground).toBe("#223344");
  });
});
