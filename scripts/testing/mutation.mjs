import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { cleanupMutationDatabases } from "./mutation-databases.mjs";
import { mutationArguments } from "./mutation-profile.mjs";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@stryker-mutator/core/package.json")), "bin/stryker.js");

function signalGroup(pid, signal, sendSignal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned mutation process group.");
  try { sendSignal(-pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** Wait for every owned descendant to stop before dropping its database. */
export async function terminateMutationProcessGroup(pid, { sendSignal = process.kill, wait = delay } = {}) {
  const gone = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!signalGroup(pid, 0, sendSignal)) return true;
      await wait(50);
    }
    return !signalGroup(pid, 0, sendSignal);
  };
  if (!signalGroup(pid, 0, sendSignal)) return;
  signalGroup(pid, "SIGTERM", sendSignal);
  if (await gone()) return;
  signalGroup(pid, "SIGKILL", sendSignal);
  if (!await gone()) throw new Error("Mutation descendants remain active; database cleanup was deferred.");
}

/** Preserve Stryker arguments and output while owning each run's temporary databases. */
export async function runMutation(args, {
  environment = process.env, spawnChild = spawn, signals = process,
  cleanup = cleanupMutationDatabases, sendSignal = process.kill,
  terminateGroup = terminateMutationProcessGroup, platform = process.platform,
  budgetMs,
} = {}) {
  const profile = mutationArguments(args);
  args = profile.args;
  if (platform === "win32") throw new Error("Mutation database isolation requires POSIX process groups.");
  const childEnvironment = {
    ...environment,
    KESTREL_MUTATION_MODE: profile.mode,
    KESTREL_MUTATION_COMPONENT: profile.component ?? "",
    KESTREL_MUTATION_RUN_ID: randomBytes(8).toString("hex"),
    KESTREL_MUTATION_DATABASE_MANIFEST: await mkdtemp(join(tmpdir(), "kestrel-mutation-")),
  };
  // Stryker assigns unique worker IDs; an inherited value would override its assignment.
  delete childEnvironment.STRYKER_MUTATOR_WORKER;
  let child;
  let forwarded = false;
  let deadline;
  let forceDeadline;
  const forward = (signal) => {
    if (!forwarded) { forwarded = true; child?.kill(signal); }
    else if (child?.pid !== undefined) signalGroup(child.pid, signal, sendSignal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  try {
    // A separate process group prevents terminal Ctrl-C from also signalling Stryker directly.
    child = spawnChild(process.execPath, [cli, "run", ...args], { stdio: "inherit", env: childEnvironment, detached: true });
    signals.on("SIGINT", interrupt);
    signals.on("SIGTERM", terminate);
    // A bounded profile saves a partial incremental report, then stops the owned group
    // if Stryker cannot finish its graceful checkpoint. Database cleanup still runs.
    if (budgetMs ?? profile.budgetMs) deadline = setTimeout(() => {
      console.info("Mutation time budget reached; saving partial results.");
      interrupt();
      forceDeadline = setTimeout(() => {
        if (child?.pid) signalGroup(child.pid, "SIGKILL", sendSignal);
      }, 5_000);
    }, budgetMs ?? profile.budgetMs);
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit(code ?? 128 + (constants.signals[signal] ?? 0)));
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(forceDeadline);
    try {
      if (child?.pid !== undefined) await terminateGroup(child.pid, { sendSignal });
      await cleanup(childEnvironment);
    }
    catch (error) {
      // Preserve the ownership records for manual recovery when PostgreSQL is unavailable.
      error.mutationDatabaseManifest = childEnvironment.KESTREL_MUTATION_DATABASE_MANIFEST;
      throw error;
    }
    finally {
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = await runMutation(process.argv.slice(2)); }
  catch (error) {
    console.error(`Mutation execution or database cleanup failed: ${error.message}`);
    if (error.mutationDatabaseManifest) console.error(`Mutation database ownership manifest: ${error.mutationDatabaseManifest}`);
    process.exitCode = 1;
  }
}
