import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runConcurrent } from "./common.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("limits concurrency and drains all checks before reporting failures", async () => {
  const first = deferred();
  const second = deferred();
  const thirdStarted = deferred();
  const events = [];
  let settled = false;
  const work = runConcurrent([
    async () => { events.push("first"); await first.promise; throw new Error("first check failed"); },
    async () => { events.push("second"); await second.promise; events.push("second finished"); },
    async () => { events.push("third"); thirdStarted.resolve(); },
  ]).finally(() => { settled = true; });
  // Attach the rejection handler before releasing a failing task.
  const failure = assert.rejects(work, (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors[0].message, "first check failed");
    return true;
  });
  assert.deepEqual(events, ["first", "second"]);
  first.resolve();
  await thirdStarted.promise;
  assert.deepEqual(events, ["first", "second", "third"]);
  assert.equal(settled, false);
  second.resolve();
  await failure;
  assert.equal(events.at(-1), "second finished");
});

test("returns task results in input order and rejects invalid concurrency", async () => {
  assert.deepEqual(await runConcurrent([async () => 1, async () => 2], 1), [1, 2]);
  assert.deepEqual(await runConcurrent([]), []);
  await assert.rejects(runConcurrent([], 0), /positive integer/);
});

test("retains command timings and exit status for successful and failed checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-command-timings-"));
  try {
    for (const exitCode of [0, 7]) {
      const log = join(directory, `${exitCode}.log`);
      const invocation = run(process.execPath, ["--eval", `console.log("retained output"); process.exitCode = ${exitCode};`], { log, capture: true });
      if (exitCode === 0) await invocation;
      else await assert.rejects(invocation, /failed \(7\)/);
      const report = JSON.parse(await readFile(`${log}.timing.json`, "utf8"));
      assert.equal(report.exitCode, exitCode);
      assert.equal(report.status, exitCode === 0 ? "passed" : "failed");
      assert(report.durationMs >= 0);
      assert(Date.parse(report.completedAt) >= Date.parse(report.startedAt));
      assert.match(await readFile(log, "utf8"), /retained output/);
    }
    const log = join(directory, "missing.log");
    await assert.rejects(run(join(directory, "missing-command"), [], { log }), /ENOENT/);
    const report = JSON.parse(await readFile(`${log}.timing.json`, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.exitCode, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
