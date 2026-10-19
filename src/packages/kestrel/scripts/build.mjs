import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Never retain obsolete emitted modules in a distributable after moving source files.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
await build("TypeScript", "tsc", ["-p", "tsconfig.build.json"]);
// Browser builds own disjoint asset trees; keep at most two compiler processes active.
const results = await Promise.allSettled([
  build("Studio", "vite", ["build", "--logLevel", "error"]),
  build("Atlas", "vite", ["build", "--config", "vite.atlas.config.ts", "--logLevel", "error"]),
]);
const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
if (failures.length) throw new AggregateError(failures, "Framework browser build failed");

/** Drain every child before returning and expose component durations in the parent build log. */
async function build(name, command, args) {
  const started = performance.now();
  try {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => signal ? reject(new Error(`${name} terminated: ${signal}`)) : resolve(code));
    });
    if (code !== 0) throw new Error(`${name} build failed (${code})`);
  } finally {
    console.info(`${name} build duration: ${Math.round(performance.now() - started)}ms`);
  }
}
