import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AtlasSignOut } from "./router-view.js";

describe("AtlasSignOut", () => {
  it("renders an accessible session control for the sidebar", () => {
    const markup = renderToStaticMarkup(<AtlasSignOut authentication={{
      loginPath: "/atlas/login",
      passwordSignInUrl: "/authentication/password/sign-in",
      signOutUrl: "/authentication/sign-out",
    }} />);

    expect(markup).toContain('class="sign-out-button"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("Protected Atlas workspace");
  });
});
