import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/packages/kestrel/src/", import.meta.url));
const failures = [];
// Check package ownership without assuming a particular checkout directory.
for (const file of await readdir(root, { recursive: true })) {
  if (!/\.tsx?$/.test(file)) continue;
  const source = await readFile(resolve(root, file), "utf8");
  for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"'\n]+)["']/g)) {
    if (specifier.startsWith(".")) {
      const target = relative(root, resolve(dirname(resolve(root, file)), specifier));
      if (target.startsWith(`..${sep}`)) failures.push(`${file}: import leaves the framework (${specifier})`);
    }
    if (/^@kestrel\//.test(specifier) || /^@kestreljs\/(?!framework(?:\/|$))/.test(specifier)) failures.push(`${file}: dependency on an external product`);
  }
  if (!/\.test\./.test(file) && /\bAgora\b|src\/(?:server|bootstrap)/.test(source)) {
    failures.push(`${file}: application-specific production reference`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
console.info("Framework ownership boundaries passed.");
