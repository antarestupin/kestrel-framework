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
    expect(fontAwesomeIcon(faUsers)).toMatchObject({
      type: "svg",
      viewBox: [0, 0, 640, 512],
      paths: [expect.objectContaining({ d: expect.any(String) })],
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
  });
});
