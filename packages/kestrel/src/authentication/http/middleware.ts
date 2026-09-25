import { dep } from "../../di/index.js";
import { defineHttpMiddleware } from "../../http/index.js";
import type { AuthenticationConfig } from "../configuration.js";
import { AuthenticationContext } from "../context.js";
import {
  AuthenticationRequiredError,
  UntrustedAuthenticationOriginError,
} from "../errors.js";
import { AuthenticationManager } from "../manager.js";
import { readAuthenticationCookie } from "./cookie.js";

/** Creates optional and required cookie-session middleware for one app policy. */
export function createAuthenticationHttpMiddleware<Claims>(
  config: AuthenticationConfig,
) {
  const optionalSession = defineHttpMiddleware(
    "authentication.http.optional-session",
    {
      dependencies: {
        authenticationContext: dep<AuthenticationContext<Claims>>(
          "authenticationContext",
        ),
        authenticationManager: dep<AuthenticationManager<Claims>>(
          "authenticationManager",
        ),
      },
      handler: async ({ request, deps }, next) => {
        await resolveAuthenticationContext(
          request.headers.cookie,
          deps.authenticationContext,
          deps.authenticationManager,
          config,
        );

        return next();
      },
    },
  );

  const requiredSession = defineHttpMiddleware(
    "authentication.http.required-session",
    {
      dependencies: {
        authenticationContext: dep<AuthenticationContext<Claims>>(
          "authenticationContext",
        ),
        authenticationManager: dep<AuthenticationManager<Claims>>(
          "authenticationManager",
        ),
      },
      handler: async ({ request, deps }, next) => {
        await resolveAuthenticationContext(
          request.headers.cookie,
          deps.authenticationContext,
          deps.authenticationManager,
          config,
        );

        if (deps.authenticationContext.getPrincipal() === undefined) {
          throw new AuthenticationRequiredError();
        }

        return next();
      },
    },
  );

  const trustedOrigin = defineHttpMiddleware(
    "authentication.http.trusted-origin",
    {
      handler: ({ request }, next) => {
        const origin = request.headers.origin;

        if (
          typeof origin !== "string"
          || !isTrustedAuthenticationOrigin(
            origin,
            request.protocol,
            request.host,
            config.http.trustedOrigins,
          )
        ) {
          throw new UntrustedAuthenticationOriginError();
        }

        return next();
      },
    },
  );

  return { optionalSession, requiredSession, trustedOrigin };
}

/** Accepts the exact request origin plus explicitly configured client origins. */
function isTrustedAuthenticationOrigin(
  source: string,
  protocol: string,
  host: string,
  configuredOrigins: readonly string[],
): boolean {
  const sourceOrigin = normalizeHttpOrigin(source);

  if (sourceOrigin === undefined) {
    return false;
  }

  const targetOrigin = normalizeHttpOrigin(`${protocol}://${host}`);

  return sourceOrigin === targetOrigin
    || configuredOrigins.some(
      (configured) => normalizeHttpOrigin(configured) === sourceOrigin,
    );
}

/** Rejects paths, credentials, fragments, and non-HTTP origin values. */
function normalizeHttpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);

    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
    ) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

async function resolveAuthenticationContext<Claims>(
  cookieHeader: string | undefined,
  context: AuthenticationContext<Claims>,
  manager: AuthenticationManager<Claims>,
  config: AuthenticationConfig,
): Promise<void> {
  if (context.value.state !== "pending") {
    return;
  }

  const token = readAuthenticationCookie(
    cookieHeader,
    config.http.cookie.name,
  );
  const principal = token === undefined
    ? undefined
    : await manager.resolve(token);

  if (principal === undefined) {
    context.resolveAnonymous();
  } else {
    context.resolveAuthenticated(principal);
  }
}
