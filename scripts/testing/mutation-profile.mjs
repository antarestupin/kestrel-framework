import { readFileSync, statSync } from "node:fs";

const sourceRoot = new URL("../../src/packages/kestrel/src/", import.meta.url);

/** Keep profile selection separate from Stryker flags and reject accidental broad scopes. */
export function mutationArguments(args) {
  const remaining = [...args];
  let mode = "full";
  let component;
  if (remaining[0] === "--mode") {
    remaining.shift();
    mode = remaining.shift();
    if (!["fast", "component", "static-sample", "shutdown", "authentication-sessions", ...Object.keys(focusedProfiles)].includes(mode)) throw new Error("Unknown mutation mode.");
    if (mode === "component") {
      component = remaining.shift();
      if (!component || !/^[a-z][a-z0-9_]*$/u.test(component)
        || !statSync(new URL(`${component}/`, sourceRoot), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error("Specify an existing framework component, for example: test:mutation:component -- di");
      }
    }
    if (remaining.some((arg) => !arg.startsWith("-") && /\.(?:mjs|cjs|js|json|ts)$/u.test(arg)
      || /^--(?:mutate|ignoreStatic|configFile)(?:=|$)/u.test(arg))) {
      throw new Error("Profile scope and static policy cannot be overridden; use test:mutation for custom runs.");
    }
  }
  // Every named assessment profile is bounded; the explicit full/custom command stays opt-in.
  return { mode, component, args: remaining, budgetMs: mode === "full" ? undefined : 600_000 };
}

/** Freeze the comparison scope to stop, disposal and shutdown error collection. */
export function shutdownPatterns() {
  const file = "app/app.ts";
  const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("public stop(): Promise<void>"));
  const end = lines.findIndex((line) => line.includes("public runInObservationContext<"));
  if (start < 0 || end <= start) throw new Error("Application shutdown boundaries disappeared.");
  return [`src/packages/kestrel/src/${file}:${start + 1}-${end}`];
}

/** Select small import-time declarations across three different dependency graphs. */
export function staticSamplePatterns() {
  const selections = {
    "authentication/configuration.ts": ["const sameSiteSchema =", "name: z.string().min(1).default", "secure: z.boolean().default", "path: z.literal"],
    "throttling/configuration.ts": ['z.object({ strategy: z.literal("reject") })', 'strategy: z.literal("emergency-local")', "backendFailurePolicy: backendFailurePolicy.default"],
    "db/configuration.ts": ["options: z.string().default", "parameters: z.enum"],
  };
  return Object.entries(selections).flatMap(([file, anchors]) => {
    const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
    return anchors.map((anchor) => {
      const line = lines.findIndex((value) => value.includes(anchor));
      if (line < 0) throw new Error(`Static sample declaration disappeared: ${file}: ${anchor}`);
      return `src/packages/kestrel/src/${file}:${line + 1}-${line + 1}`;
    });
  });
}

// Keep each behavioral lot independent so reports and ten-minute budgets stay comparable.
const focusedProfiles = {
  "authorization-decisions": [["authorization/manager.ts"]],
  "password-verification": [["authentication/mechanisms/password/hashers/argon2id/hasher.ts"]],
  "postgres-ownership": [
    ["workflows/adapters/postgres/adapter.ts", "public async retryTask(", "public async reserveActivityDispatches("],
    ["scheduled_tasks/adapters/postgres/adapter.ts", "public async extendLease(", "public async pruneExpiredRuns("],
  ],
  "throttling-inspection": [["throttling/adapters/leased/adapter.ts", "public reconcile(", "public allocateLeases("]],
  "lock-renewal": [
    ["lock/lock_manager.ts", "private async extendMany(", "private async tryAcquireMany("],
    ["lock/lock_manager.ts", "function validateExtensionBatch(", "/** Mutable internal implementation"],
  ],
};

/** Resolve anchored ranges after source edits; fail closed if a boundary disappears. */
export function focusedPatterns(mode) {
  return focusedProfiles[mode]?.map(([file, startAnchor, endAnchor]) => {
    const prefix = `src/packages/kestrel/src/${file}`;
    if (startAnchor === undefined) return prefix;
    const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
    const start = lines.findIndex((line) => line.includes(startAnchor));
    const end = lines.findIndex((line, index) => index > start && line.includes(endAnchor));
    if (start < 0 || end <= start) throw new Error(`Mutation lot boundaries disappeared: ${mode}: ${file}`);
    return `${prefix}:${start + 1}-${end}`;
  });
}
