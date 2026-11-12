import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogIcon, Icon } from "./icon.js";

const glyph = {
  type: "svg",
  viewBox: [0, 0, 8, 8],
  paths: [{ d: "M1 1h6v6H1z", opacity: 0.5 }],
} as const;

describe("Studio icons", () => {
  it("renders a labeled, spinning custom icon and its path", () => {
    const markup = renderToStaticMarkup(<Icon icon={glyph} label="Refreshing" className="status-icon" spin />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Refreshing"');
    expect(markup).toContain("kestrel-icon spinning status-icon");
    expect(markup).toContain('opacity="0.5"');
  });

  it("falls back for inherited names and uses an explicitly registered name", () => {
    const fallback = renderToStaticMarkup(<Icon name="table" />);
    expect(renderToStaticMarkup(<CatalogIcon catalog={{}} iconId="constructor" fallback="table" />)).toBe(fallback);
    const configured = renderToStaticMarkup(
      <CatalogIcon catalog={{ constructor: glyph }} iconId="constructor" fallback="table" />,
    );
    expect(configured).toContain('viewBox="0 0 8 8"');
    expect(configured).toContain('aria-hidden="true"');
  });

  it("renders nothing when no icon was requested", () => {
    expect(renderToStaticMarkup(<Icon />)).toBe("");
  });
});
