import type { FastifyRequest } from "fastify";

import type { createAuthenticationActions } from "../actions.js";
import { passwordSignInHttpInputSchema } from "../actions.js";
import type { AuthenticationConfig } from "../configuration.js";
import type {
  AuthenticationSubject,
} from "../types.js";
import {
  defineActionHttpController,
  get,
  post,
  type HttpAccessPolicy,
} from "../../http/index.js";
import {
  clearAuthenticationCookie,
  createAuthenticationCookie,
} from "./cookie.js";
import { createAuthenticationHttpMiddleware } from "./middleware.js";

export interface AuthenticationHttpControllerOptions {
  readonly prefix?: string;
}

/** Creates app-owned HTTP definitions around authentication Actions. */
export function createAuthenticationHttpControllers<
  Subject extends AuthenticationSubject,
  Claims,
>(
  authentication: ReturnType<
    typeof createAuthenticationActions<Subject, Claims>
  >,
  config: AuthenticationConfig,
  access: HttpAccessPolicy,
  options: AuthenticationHttpControllerOptions = {},
) {
  const prefix = normalizePrefix(options.prefix ?? "/authentication");
  const middleware = createAuthenticationHttpMiddleware<Claims>(config);

  const signInWithPassword = defineActionHttpController(
    authentication.actions.signInWithPassword,
    post(`${prefix}/password/sign-in`),
    {
      access,
      input: passwordSignInHttpInputSchema,
      output: authentication.schemas.principal,
      // Credential requests are intentionally much smaller than normal JSON APIs.
      fastify: { bodyLimit: 8 * 1_024 },
      middleware: [middleware.trustedOrigin],
      successStatusCode: 200,
      handler: async ({ action, input, request, reply }) => {
        const grant = await action.run({
          ...input,
          metadata: getAttemptMetadata(request),
        });
        reply.header(
          "set-cookie",
          createAuthenticationCookie(grant.token, config.http.cookie),
        );
        reply.header("cache-control", "no-store");

        return grant.principal;
      },
    },
  );

  const signOut = defineActionHttpController(
    authentication.actions.signOut,
    post(`${prefix}/sign-out`),
    {
      access,
      middleware: [middleware.trustedOrigin, middleware.optionalSession],
      successStatusCode: 204,
      handler: async ({ action, reply }) => {
        await action.run({});
        reply.header(
          "set-cookie",
          clearAuthenticationCookie(config.http.cookie),
        );
        reply.header("cache-control", "no-store");
        reply.code(204).send();

        return null;
      },
    },
  );

  const getCurrentSession = defineActionHttpController(
    authentication.actions.getCurrentSession,
    get(`${prefix}/session`),
    {
      access,
      middleware: [middleware.optionalSession],
      successStatusCode: 200,
    },
  );

  return {
    signInWithPassword,
    signOut,
    getCurrentSession,
    middleware,
  };
}

function getAttemptMetadata(request: FastifyRequest): {
  readonly ipAddress: string;
  readonly userAgent?: string;
} {
  const userAgent = request.headers["user-agent"];

  return {
    ipAddress: request.ip,
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function normalizePrefix(prefix: string): string {
  if (!prefix.startsWith("/") || prefix.endsWith("/")) {
    throw new TypeError(
      "Authentication HTTP prefix must start with one slash and omit a trailing slash.",
    );
  }

  return prefix;
}
