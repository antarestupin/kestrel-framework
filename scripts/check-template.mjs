import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the application consumer aligned with the canonical generated application.
const source = new URL("../templates/web/", import.meta.url);
const playground = new URL("../apps/playground/", import.meta.url);
for (const file of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const path = relative(fileURLToPath(source), join(file.parentPath, file.name));
  const expected = await readFile(new URL(path, source), "utf8");
  const actual = await readFile(new URL(path, playground), "utf8");
  // Launchers must remain executable when synchronized or copied into the creator.
  const sourceMode = (await stat(new URL(path, source))).mode & 0o111;
  assert.equal((await stat(new URL(path, playground))).mode & 0o111, sourceMode, `${path}: executable permissions`);
  if (path === "package.json") {
    const left = JSON.parse(expected), right = JSON.parse(actual);
    left.name = right.name;
    assert.deepEqual(left, right, path);
  } else assert.equal(actual, expected, path);
}
// Source parity also rejects obsolete entry points left behind after a template removal.
const sourceFiles = async (root) => (await readdir(new URL("src/", root), { recursive: true, withFileTypes: true }))
  .filter((file) => file.isFile())
  .map((file) => relative(fileURLToPath(new URL("src/", root)), join(file.parentPath, file.name)))
  .sort();
assert.deepEqual(await sourceFiles(playground), await sourceFiles(source), "Application source file inventory");
console.info("Playground and starter template are aligned.");
