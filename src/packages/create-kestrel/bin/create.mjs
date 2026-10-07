#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createApplication } from "../generators/index.mjs";

const usage = `Usage: create-kestrel <app-name> [--framework-archive <local-framework.tgz>]
  Creates <app-name>/ in the current directory; no manual mkdir is needed.
  A relative or absolute path is also accepted. Existing directories must be empty.

  --framework-archive      Use a local archive instead of the bundled registry version.
  --cache <postgres|redis>  Select the cache backend (default: postgres).
  --atlas / --no-atlas      Include or omit Atlas (default: included).
  --yes                    Use defaults without interactive questions.
  --help                   Show this help.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "framework-archive": { type: "string" },
      cache: { type: "string" },
      atlas: { type: "boolean" },
      "no-atlas": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(usage);
  } else {
    if (positionals.length !== 1) throw new Error(usage);
    // Reject contradictory choices instead of silently selecting one.
    if (values.atlas && values["no-atlas"]) throw new Error("Choose either --atlas or --no-atlas.");
    // Both interfaces use the same generator; redirected input never starts prompts.
    await createApplication({
      directory: positionals[0],
      frameworkArchive: values["framework-archive"],
      cache: values.cache,
      atlas: values["no-atlas"] ? false : values.atlas,
      interactive: !values.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
