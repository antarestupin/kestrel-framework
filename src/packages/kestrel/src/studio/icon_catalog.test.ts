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

describe("Studio IconCatalogBuilder", () => {
  it("normalizes an explicitly imported Font Awesome definition", () => {
    expect(fontAwesomeIcon(faUsers)).toMatchObject({
      type: "svg",
      viewBox: [0, 0, 640, 512],
      paths: [expect.objectContaining({ d: expect.any(String) })],
    });
    expect(fontAwesomeIcon(faUsers).paths[0]).not.toHaveProperty("opacity");
  });

  it("applies secondary opacity only to the first path of a layered icon", () => {
    expect(fontAwesomeIcon({
      ...faUsers,
      icon: [16, 12, [], "0", ["M1 1h2", "M2 2h3"]],
    })).toEqual({
      type: "svg", viewBox: [0, 0, 16, 12],
      paths: [{ d: "M1 1h2", opacity: 0.4 }, { d: "M2 2h3" }],
    });
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
    expect(catalog.add({ ...squareIcon, paths: [{ d: squareIcon.paths[0]!.d, opacity: 0 }] })).toBe("icon-3");
    expect(catalog.add({ ...squareIcon, paths: [{ d: squareIcon.paths[0]!.d, opacity: 0.4 }] })).toBe("icon-4");
  });
});
