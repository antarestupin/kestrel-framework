import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AtlasLogin } from "./login.js";

describe("AtlasLogin", () => {
  it("renders an accessible Kestrel-owned password form", () => {
    const markup = renderToStaticMarkup(<AtlasLogin config={{
      basePath: "/atlas",
      title: "Atlas",
      authentication: {
        loginPath: "/atlas/login",
        passwordSignInUrl: "/authentication/password/sign-in",
        signOutUrl: "/authentication/sign-out",
      },
    }} />);

    expect(markup).toContain("Sign in to Atlas");
    expect(markup).toContain('name="username"');
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('type="submit"');
  });
});
