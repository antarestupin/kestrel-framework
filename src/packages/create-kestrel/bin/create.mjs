#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createApplication } from "../generators/index.mjs";

const usage = `Usage: create-kestrel <directory> --framework-archive <local-framework.tgz>
  --cache <postgres|redis>  Select the cache backend (default: postgres).
  --redis-insight           Add Redis Insight when Redis is installed.
  --no-redis-insight        Skip Redis Insight.
  --yes                    Use defaults without interactive questions.
  --help                   Show this help.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "framework-archive": { type: "string" },
      cache: { type: "string" },
      "redis-insight": { type: "boolean" },
      "no-redis-insight": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(usage);
  } else {
    if (positionals.length !== 1 || !values["framework-archive"]) throw new Error(usage);
    if (values["redis-insight"] && values["no-redis-insight"]) {
      throw new Error("Choose either --redis-insight or --no-redis-insight.");
    }
    // Both interfaces use the same generator; redirected input never starts prompts.
    await createApplication({
      directory: positionals[0],
      frameworkArchive: values["framework-archive"],
      cache: values.cache,
      redisInsight: values["redis-insight"] ? true : values["no-redis-insight"] ? false : undefined,
      interactive: !values.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
