import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest, root, writeJson } from "./common.mjs";
import { reportInventory } from "./candidate.mjs";
import { verificationSelections } from "./evidence.mjs";

/** Exercise the real publication CLI with local evidence and a replacement npm that cannot publish. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-interactive-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archives = [];
  for (const name of ["framework", "create-kestrel"]) {
    const file = `${name}.tgz`;
    await writeFile(join(directory, file), "local test fixture, not an npm archive");
    archives.push({ name: `@kestreljs/${name}`, file, sha256: await digest(join(directory, file)) });
  }
  const manifest = { format: 1, status: "validated", source: { dirty: false },
    validatedAt: new Date().toISOString(), archives, verifications: [{ node: "v24.11.0" }] };
  const receipt = { source: manifest.source, node: "v24.11.0", npm: "11.9.0", status: "passed" };
  await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [] });
  await writeJson(join(directory, "reports/docs/result.json"), receipt);
  for (const selection of verificationSelections) {
    await writeJson(join(directory, "reports/consumers", selection, "result.json"), { ...receipt, selection, archives });
  }
  manifest.reports = await reportInventory(directory);
  await writeJson(join(directory, "candidate.json"), manifest);
  const fakeNpm = join(directory, "fake-npm.mjs");
  // No npm module or registry request is involved; record arguments and test inherited input/output.
  await writeFile(fakeNpm, `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "calls.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("fake npm input: " + readFileSync(0, "utf8").trim());
console.error("fake npm stderr");
process.exitCode = Number(process.env.KESTREL_FAKE_NPM_EXIT ?? 0);
`);
  return { directory, manifest, fakeNpm };
}

/** Pipe a harmless response into the CLI; inherited stdin must reach the fake npm subprocess. */
async function invoke({ directory, fakeNpm }, exitCode = 0) {
  const child = spawn(process.execPath, ["scripts/release.mjs", "publish", directory, "all"], {
    cwd: root, env: { ...process.env, npm_execpath: fakeNpm, KESTREL_FAKE_NPM_EXIT: String(exitCode) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // A rejected candidate can exit before reading; that is an expected closed input pipe.
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end("test authentication response\n");
  return completion;
}

test("publication inherits terminal streams and publishes only validated archives in order", async (t) => {
  const state = await fixture(t);
  const result = await invoke(state);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake npm input: test authentication response/);
  assert.equal(result.stderr.match(/fake npm stderr/g)?.length, 2);
  const calls = (await readFile(join(state.directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, state.manifest.archives.map((archive) => [
    "publish", join(state.directory, archive.file), "--ignore-scripts", "--access", "public", "--tag", "next",
  ]));
  assert.equal(await readFile(join(state.directory, "candidate.json"), "utf8"), JSON.stringify(state.manifest, null, 2) + "\n");
  assert.deepEqual(await reportInventory(state.directory), state.manifest.reports);
});

test("publication rejects a changed archive before invoking npm", async (t) => {
  const state = await fixture(t);
  await writeFile(join(state.directory, state.manifest.archives[0].file), "changed archive");
  const result = await invoke(state);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Changed artifact/);
  await assert.rejects(readFile(join(state.directory, "calls.jsonl")), { code: "ENOENT" });
});

test("interactive npm failure stops publication before the creator", async (t) => {
  const state = await fixture(t);
  const result = await invoke(state, 23);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /failed \(23\)/);
  const calls = (await readFile(join(state.directory, "calls.jsonl"), "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
});
