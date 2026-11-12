// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtlasLogin } from "./login.js";
import * as loginRuntime from "./login_runtime.js";
import { AtlasSignOut } from "./router-view.js";

const authentication = {
  loginPath: "/atlas/login",
  passwordSignInUrl: "/auth/password",
  signOutUrl: "/auth/sign-out",
};
const config = { basePath: "/atlas", title: "Atlas", authentication };

describe("Atlas authentication interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", "/");
    }
  });

  async function loginForm() {
    await act(async () => root.render(<AtlasLogin config={config} />));
    const form = host.querySelector("form")!;
    form.querySelector<HTMLInputElement>('[name="username"]')!.value = "operator";
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = "test-password";
    return form;
  }

  it("keeps one sign-in request pending and allows retry after a refusal", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const form = await loginForm();

    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/auth/password", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "test-password" }),
    });
    expect(form.querySelector("button")?.disabled).toBe(true);

    await act(async () => pending.resolve(new Response(null, { status: 401 })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("credentials are invalid");
    expect(form.querySelector("button")?.disabled).toBe(false);

    await act(async () => form.requestSubmit());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Too many sign-in attempts");
    expect(form.querySelector("button")?.disabled).toBe(false);
  });

  it.each([
    [403, "not trusted from its current address"],
    [503, "temporarily unavailable"],
  ])("shows HTTP %s on the login form", async (status, message) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    const form = await loginForm();
    await act(async () => form.requestSubmit());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(form.querySelector("button")?.disabled).toBe(false);
  });

  it("returns to the requested Atlas record after authenticating", async () => {
    const navigate = vi.spyOn(loginRuntime, "navigateAfterAuthentication").mockImplementation(() => {});
    const target = "/atlas/widgets/42?tab=history";
    window.history.replaceState(null, "", `/atlas/login?returnTo=${encodeURIComponent(target)}`);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const form = await loginForm();
    await act(async () => form.requestSubmit());
    expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
    expect(form.querySelector("button")?.disabled).toBe(true);
  });

  it("retains the sign-out control after a request failure", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(<AtlasSignOut authentication={authentication} />));
    const button = host.querySelector("button")!;

    await act(async () => button.click());
    expect(button.textContent).toContain("Signing out");
    expect(button.disabled).toBe(true);
    await act(async () => pending.reject(new Error("offline")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sign-out failed");
    expect(button.disabled).toBe(false);
    const navigate = vi.spyOn(loginRuntime, "navigateAfterAuthentication").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(async () => button.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authentication.loginPath);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("uses document navigation for the authentication transition", () => {
    // A hash-only target lets jsdom exercise Location.assign without a network.
    loginRuntime.navigateAfterAuthentication("#authenticated");
    expect(window.location.hash).toBe("#authenticated");
  });
});
