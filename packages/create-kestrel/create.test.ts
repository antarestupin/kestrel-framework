import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const executable = fileURLToPath(new URL("./bin/create.mjs", import.meta.url));
it("preserves existing files when the target is not empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-creator-"));
  try {
    const target = join(root, "existing-app");
    const archive = join(root, "framework.tgz");
    await mkdir(target);
    await writeFile(join(target, "package.json"), "do not overwrite");
    await writeFile(archive, "local fixture archive");
    const result = spawnSync(process.execPath, [executable, target, "--framework-archive", archive], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("destination must be empty");
    expect(await readFile(join(target, "package.json"), "utf8")).toBe("do not overwrite");
  } finally {
    // The test owns this temporary directory, including failure paths.
    await rm(root, { recursive: true, force: true });
  }
});
