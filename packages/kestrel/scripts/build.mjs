import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Never retain obsolete emitted modules in a distributable after moving source files.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
for (const [command, args] of [["tsc", ["-p", "tsconfig.build.json"]], ["vite", ["build", "--logLevel", "error"]]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
