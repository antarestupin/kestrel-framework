import helmet from "@fastify/helmet";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { HttpRuntimeServerOptions } from "../runtime.js";
import type { HttpHardeningConfig } from "./configuration.js";

const contentSecurityPolicyDirectives = {
  "base-uri": ["'none'"],
  "connect-src": ["'self'"],
  "default-src": ["'none'"],
  "font-src": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "img-src": ["'self'", "data:"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "upgrade-insecure-requests": [],
};
const contentSecurityPolicyHeader = Object.entries(
  contentSecurityPolicyDirectives,
).map(([directive, values]) => [directive, ...values].join(" ")).join(";");

export interface HttpHardeningProfile {
  /** Fastify construction options that must be present from server creation. */
  readonly server: HttpRuntimeServerOptions;
  /** Installs root policies before application extensions and routes. */
  install(server: FastifyInstance): void;
}

/** Builds an explicit production-oriented HTTP policy from application config. */
export function createHttpHardeningProfile(
  config: HttpHardeningConfig,
): HttpHardeningProfile {
  if (!config.enabled) {
    throw new TypeError("An HTTP hardening profile must be enabled before use.");
  }

  const allowedHosts = new Set(
    config.publicOrigins.map((origin) => new URL(origin).host),
  );
  const securityHeaderOptions: NonNullable<
    Parameters<FastifyReply["helmet"]>[0]
  > = {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    hsts: {
      maxAge: config.hsts.maxAgeSeconds,
      includeSubDomains: config.hsts.includeSubDomains,
      preload: config.hsts.preload,
    },
    referrerPolicy: { policy: "no-referrer" },
    xFrameOptions: { action: "deny" },
  };

  return {
    server: {
      bodyLimit: config.limits.bodyBytes,
      connectionTimeout: config.timeouts.connectionMs,
      forceCloseConnections: "idle",
      handlerTimeout: config.timeouts.handlerMs,
      keepAliveTimeout: config.timeouts.keepAliveMs,
      maxRequestsPerSocket: config.limits.maxRequestsPerSocket,
      onConstructorPoisoning: "error",
      onProtoPoisoning: "error",
      requestTimeout: config.timeouts.requestMs,
      return503OnClosing: true,
      trustProxy: config.proxy.mode === "trusted"
        ? [...config.proxy.cidrs]
        : false,
    },
    install(server) {
      // Fastify does not expose these Node HTTP controls as factory options.
      server.server.headersTimeout = config.timeouts.headersMs;
      server.server.keepAliveTimeoutBuffer = config.timeouts.keepAliveBufferMs;
      server.server.maxHeadersCount = config.limits.maxHeadersCount;

      server.addHook("onRequest", async (request, reply) => {
        if (!isAllowedHost(request, allowedHosts)) {
          // Host admission runs before Helmet, so rejected requests receive
          // the same essential response policy directly.
          applyRejectedRequestSecurityHeaders(reply, config);
          await reply.code(421).send({
            error: "Misdirected Request",
            message: "The request host is not accepted by this server.",
            statusCode: 421,
          });
        }
      });
      server.addHook("onSend", async (_request, reply, payload) => {
        // Helmet deliberately does not manage Permissions Policy.
        reply.header(
          "permissions-policy",
          "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        );

        return payload;
      });

      server.register(helmet, {
        global: true,
        ...securityHeaderOptions,
      });
    },
  };
}

function applyRejectedRequestSecurityHeaders(
  reply: FastifyReply,
  config: HttpHardeningConfig,
): void {
  const hsts = [
    `max-age=${config.hsts.maxAgeSeconds}`,
    config.hsts.includeSubDomains ? "includeSubDomains" : undefined,
    config.hsts.preload ? "preload" : undefined,
  ].filter((value): value is string => value !== undefined).join("; ");

  reply.headers({
    "content-security-policy": contentSecurityPolicyHeader,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "referrer-policy": "no-referrer",
    "strict-transport-security": hsts,
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "x-download-options": "noopen",
    "x-frame-options": "DENY",
    "x-permitted-cross-domain-policies": "none",
    "x-xss-protection": "0",
  });
}

function isAllowedHost(
  request: FastifyRequest,
  allowedHosts: ReadonlySet<string>,
): boolean {
  try {
    const candidate = new URL(`http://${request.host}`);

    return candidate.username === ""
      && candidate.password === ""
      && candidate.pathname === "/"
      && candidate.search === ""
      && candidate.hash === ""
      && allowedHosts.has(candidate.host);
  } catch {
    return false;
  }
}
