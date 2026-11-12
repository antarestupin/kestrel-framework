import { definition as faUsers } from "@fortawesome/free-solid-svg-icons/faUsers";
import { describe, expect, it } from "vitest";

import {
  fontAwesomeIcon,
  type SvgIconDefinition,
} from "./icon_definition.js";
import { IconCatalogBuilder } from "./icon_catalog.js";

const squareIcon: SvgIconDefinition = {
  type: "svg",
  viewBox: [0, 0, 16, 16],
  paths: [{ d: "M1 1h14v14H1z" }],
};

describe("atlas IconCatalogBuilder", () => {
  it("normalizes an explicitly imported Font Awesome definition", () => {
    const icon = fontAwesomeIcon(faUsers);
    expect(icon).toMatchObject({
      type: "svg",
      viewBox: [0, 0, 640, 512],
      paths: [expect.objectContaining({ d: expect.any(String) })],
    });
    expect(icon.paths[0]).not.toHaveProperty("opacity");
  });

  it("applies opacity only to the secondary path of a duotone icon", () => {
    const [width, height, ligatures, unicode] = faUsers.icon;
    const secondary = "M1 1h10v10H1z";
    const primary = "M2 2h12v12H2z";
    expect(fontAwesomeIcon({ ...faUsers, icon: [width, height, ligatures, unicode, [secondary, primary]] }).paths)
      .toEqual([{ d: secondary, opacity: 0.4 }, { d: primary }]);
  });

  it("deduplicates equivalent icon definitions", () => {
    const catalog = new IconCatalogBuilder();

    expect(catalog.add(squareIcon)).toBe("icon-1");
    expect(catalog.add({ ...squareIcon })).toBe("icon-1");
    expect(catalog.toManifest()).toEqual({ "icon-1": squareIcon });
  });

  it("assigns deterministic sequential references", () => {
    const catalog = new IconCatalogBuilder();
    const secondIcon: SvgIconDefinition = {
      ...squareIcon,
      paths: [{ d: "M2 2h12v12H2z" }],
    };

    expect(catalog.add(squareIcon)).toBe("icon-1");
    expect(catalog.add(secondIcon)).toBe("icon-2");
  });

  it("does not deduplicate different opacities of the same icon path", () => {
    const catalog = new IconCatalogBuilder();
    const muted = { ...squareIcon, paths: [{ ...squareIcon.paths[0]!, opacity: 0.4 }] };
    expect(catalog.add(squareIcon)).toBe("icon-1");
    expect(catalog.add(muted)).toBe("icon-2");
    expect(catalog.add({ ...muted })).toBe("icon-2");
  });
});
