import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";

// The playground is maintained separately from the package-owned starter template.
// Keep them aligned so playground tests exercise the application users generate.
// Compare template file contents and executable permissions, plus the complete
// source file inventory; only the package name may differ in package.json.
const source = new URL("../src/packages/create-kestrel/template/", import.meta.url);
const playground = new URL("../src/apps/playground/", import.meta.url);
for (const file of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const templatePath = relative(fileURLToPath(source), join(file.parentPath, file.name));
  // Generation restores the hidden filename that npm otherwise excludes from its archive.
  const path = templatePath === "gitignore" ? ".gitignore" : templatePath;
  const expected = await readFile(new URL(templatePath, source), "utf8");
  const actual = await readFile(new URL(path, playground), "utf8");
  // Launchers must retain the executable permissions of the package-owned template.
  const sourceMode = (await stat(new URL(templatePath, source))).mode & 0o111;
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
