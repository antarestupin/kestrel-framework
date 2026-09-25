import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// Keep the application consumer aligned with the canonical generated application.
const source = new URL("../templates/web/", import.meta.url);
const playground = new URL("../apps/playground/", import.meta.url);
for (const file of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const { relative, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const path = relative(fileURLToPath(source), join(file.parentPath, file.name));
  const expected = await readFile(new URL(path, source), "utf8");
  const actual = await readFile(new URL(path, playground), "utf8");
  if (path === "package.json") {
    const left = JSON.parse(expected), right = JSON.parse(actual);
    left.name = right.name;
    assert.deepEqual(left, right, path);
  } else assert.equal(actual, expected, path);
}
console.info("Playground and starter template are aligned.");
