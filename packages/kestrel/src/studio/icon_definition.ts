import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

export interface SvgIconPathDefinition {
  readonly d: string;
  readonly opacity?: number;
}

/** Transport-safe SVG data accepted by Studio definitions. */
export interface SvgIconDefinition {
  readonly type: "svg";
  readonly viewBox: readonly [number, number, number, number];
  readonly paths: readonly SvgIconPathDefinition[];
}

/** Converts any explicitly imported Font Awesome icon into manifest-safe SVG data. */
export function fontAwesomeIcon(
  definition: IconDefinition,
): SvgIconDefinition {
  const [width, height, , , pathData] = definition.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];

  return {
    type: "svg",
    viewBox: [0, 0, width, height],
    paths: paths.map((d, index) => ({
      d,
      // Font Awesome duotone icons put their secondary layer first.
      ...(paths.length > 1 && index === 0 ? { opacity: 0.4 } : {}),
    })),
  };
}
