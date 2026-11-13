import { expect, it, vi } from "vitest";

import { authenticationConfigBase } from "../configuration.js";
import { AuthenticationContext } from "../context.js";
import { UntrustedAuthenticationOriginError } from "../errors.js";
import { createAuthenticationHttpMiddleware } from "./middleware.js";

const config = authenticationConfigBase.schema.parse({
  session: {}, mechanisms: { password: {} },
  http: { cookie: { name: "session" }, trustedOrigins: ["https://app.example"] },
});

it("rejects an ambiguous Origin header without invoking the next handler", async () => {
  const handler = createAuthenticationHttpMiddleware(config).trustedOrigin.handler;
  const next = vi.fn();
  const context = {
    request: { headers: { origin: ["https://app.example"] }, protocol: "https", host: "app.example" },
  } as unknown as Parameters<typeof handler>[0];

  // Passing an array through URL parsing would coerce a one-element array into a trusted string.
  await expect(async () => handler(context, next)).rejects.toBeInstanceOf(UntrustedAuthenticationOriginError);
  expect(next).not.toHaveBeenCalled();
});

it("rejects a malformed Origin with the authentication denial", async () => {
  const handler = createAuthenticationHttpMiddleware(config).trustedOrigin.handler;
  const next = vi.fn();
  const context = {
    request: { headers: { origin: "not a URL" }, protocol: "https", host: "app.example" },
  } as unknown as Parameters<typeof handler>[0];

  // An invalid URL must stay an authentication denial instead of escaping as a URL error.
  await expect(async () => handler(context, next)).rejects.toBeInstanceOf(UntrustedAuthenticationOriginError);
  expect(next).not.toHaveBeenCalled();
});

it.each([undefined, "session=%ZZ", "session=one; session=two"])(
  "resolves anonymously without querying the manager when the cookie header is %j",
  async (cookie) => {
    const handler = createAuthenticationHttpMiddleware(config).optionalSession.handler;
    const resolve = vi.fn();
    const authenticationContext = new AuthenticationContext();
    const context = {
      request: { headers: { cookie } }, deps: { authenticationContext, authenticationManager: { resolve } },
    } as unknown as Parameters<typeof handler>[0];
    const next = vi.fn(async () => "response");

    await expect(handler(context, next)).resolves.toBe("response");
    expect(resolve).not.toHaveBeenCalled();
    expect(authenticationContext.value).toEqual({ state: "anonymous" });
  },
);
