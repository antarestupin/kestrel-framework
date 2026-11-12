import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AtlasBrand } from "./brand.js";

// Both placements reuse the same accessible image and theme variant contract.
describe("AtlasBrand", () => {
  it.each([false, true])("renders application logos for login=%s", (login) => {
    const html = renderToStaticMarkup(<AtlasBrand login={login} title="Example" branding={{
      logo: { src: "/logo.svg", darkSrc: "/dark.svg", alt: "Example logo" },
    }} />);
    expect(html).toContain('src="/logo.svg"');
    expect(html).toContain('src="/dark.svg"');
    expect(html).toContain('alt="Example logo"');
    expect(html).toContain(`class="${login ? "login-brand-mark" : "brand-mark"} has-logo"`);
    expect(html).toContain('class="brand-image-light"');
    expect(html).toContain('class="brand-image-dark"');
  });
  it("keeps the title initial when no logo is supplied", () => {
    expect(renderToStaticMarkup(<AtlasBrand title="Example" />))
      .toBe('<span class="brand-mark"><span aria-hidden="true">E</span></span>');
  });
});
