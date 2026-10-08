import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
export const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
};
export const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

/** Reject paths escaping the candidate before reading or publishing an artifact. */
export function candidateFile(directory, path) {
  const target = resolve(directory, path);
  const rel = relative(directory, target);
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error(`Invalid candidate path: ${path}`);
  return target;
}

/** Stream progress and retain the same output as release evidence; never invoke a shell. */
export async function run(command, args, { cwd = root, log, env = process.env, capture = false, allowed = [0] } = {}) {
  await mkdir(log ? dirname(log) : cwd, { recursive: true });
  const output = log ? createWriteStream(log) : undefined;
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => { output?.write(chunk); if (capture) chunks.push(chunk); else process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output?.write(chunk); process.stderr.write(chunk); });
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => signal ? reject(new Error(`${command} terminated: ${signal}`)) : resolve(code)); });
    if (!allowed.includes(code)) throw new Error(`${command} ${args.join(" ")} failed (${code}).`);
    return { code, stdout: Buffer.concat(chunks).toString("utf8") };
  } finally {
    if (output) await new Promise((resolve, reject) => { output.once("error", reject); output.end(resolve); });
  }
}
export function npm(args, options) {
  // Use the current Node runtime even after setup-node changes the CI matrix runtime.
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], options)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}
