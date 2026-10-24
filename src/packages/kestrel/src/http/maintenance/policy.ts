import type { FastifyInstance, FastifyRequest } from "fastify";

import type { HttpMaintenanceConfig } from "./configuration.js";

// The fallback page needs neither application assets nor client-side JavaScript.
const defaultMaintenanceHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Maintenance</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; color: #202631; background: #f5f7fa; }
    main { max-width: 36rem; padding: 2rem; text-align: center; }
    h1 { font-size: 2rem; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>We'll be back soon</h1>
    <p>The site is temporarily unavailable for maintenance. Please try again later.</p>
  </main>
</body>
</html>`;

/** Installs root admission before body parsing, execution scopes and extensions. */
export function installHttpMaintenance(
  server: FastifyInstance,
  config: HttpMaintenanceConfig,
): void {
  if (!config.enabled) return;

  // Compile once so later mutation of application configuration cannot toggle admission.
  const exceptions = config.exceptions.map((exception) => ({
    path: exception.path,
    methods: exception.methods === undefined ? undefined : new Set<string>(exception.methods),
  }));
  const apiPrefixes = config.apiPathPrefixes.map((prefix) => prefix.replace(/\/+$/u, ""));
  const html = config.html ?? defaultMaintenanceHtml;
  const retryAfter = config.retryAfterSeconds;

  server.addHook("onRequest", async (request, reply) => {
    // Do not decode or normalize paths: an exception must not broaden admission.
    const path = request.raw.url?.split("?", 1)[0] ?? "/";
    if (exceptions.some((exception) => exception.path === path
      && (exception.methods === undefined || exception.methods.has(request.method)))) {
      return;
    }

    reply.code(503).header("cache-control", "no-store").header("vary", "Accept");
    if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));

    // API paths and mutations always keep a machine-readable failure contract.
    const isApi = apiPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    const isHtml = !isApi && prefersMaintenanceHtml(request);
    reply.type(isHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8");

    // Unmatched HEAD requests do not inherit Fastify's generated HEAD handler.
    if (request.method === "HEAD") return reply.send();
    if (isHtml) return reply.send(html);

    return reply.send({
      statusCode: 503,
      error: "Service Unavailable",
      message: "The site is temporarily unavailable for maintenance. Please try again later.",
    });
  });
}

/** HTML requires an explicit acceptable text/html range on a read request. */
function prefersMaintenanceHtml(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const ranges = (request.headers.accept ?? "").toLowerCase().split(",").map((range) => {
    const [type, ...parameters] = range.trim().split(";");
    const qualityParameter = parameters.map((value) => value.trim())
      .find((value) => value.startsWith("q="));
    const quality = qualityParameter === undefined ? 1
      : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(qualityParameter.slice(2))
        ? Number(qualityParameter.slice(2)) : 0;

    return { type: type?.trim(), quality };
  });
  const qualityFor = (type: string) => Math.max(
    ...ranges.filter((range) => range.type === type).map((range) => range.quality),
    -1,
  );
  const htmlQuality = qualityFor("text/html");
  if (htmlQuality <= 0) return false;

  // More specific JSON preferences override wildcards, including q=0 exclusions.
  const jsonQuality = qualityFor("application/json");
  const applicationQuality = qualityFor("application/*");
  const effectiveJsonQuality = jsonQuality >= 0 ? jsonQuality
    : applicationQuality >= 0 ? applicationQuality : Math.max(qualityFor("*/*"), 0);

  // Equal explicit preferences favor JSON; explicit HTML wins over a wildcard tie.
  return htmlQuality > effectiveJsonQuality
    || (htmlQuality === effectiveJsonQuality && jsonQuality < 0);
}
