import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupMutationDatabases, mutationDatabaseName, provisionMutationDatabase } from "./mutation-databases.mjs";
import { runMutation, terminateMutationProcessGroup } from "./mutation.mjs";

const runId = "0123456789abcdef";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-mutation-test-"));
  const environment = {
    KESTREL_MUTATION_RUN_ID: runId, KESTREL_MUTATION_DATABASE_MANIFEST: directory,
    STRYKER_MUTATOR_WORKER: "12", DB_HOST: "test-postgres", DB_PORT: "55433",
    DB_USER: "test-owner", DB_PASSWORD: "test-password",
  };
  const databases = new Set(["postgres", "kestrel_test", "kestrel_playground"]);
  const queries = [];
  const clients = [];
  const createClient = (config) => {
    const client = {
      config, ended: false,
      async connect() {},
      async query(sql, values) {
        queries.push([sql, values]);
        if (sql.startsWith("SELECT")) return { rowCount: Number(databases.has(values[0])) };
        const database = sql.match(/"([a-z0-9_]+)"/u)?.[1];
        assert.ok(database, "Administrative SQL must quote a validated database name");
        if (sql.startsWith("CREATE")) databases.add(database);
        else if (sql.startsWith("DROP")) databases.delete(database);
        else assert.fail("Unexpected administrative query");
      },
      async end() { this.ended = true; },
    };
    clients.push(client);
    return client;
  };
  return { environment, directory, databases, queries, clients, createClient,
    async dispose() { await rm(directory, { recursive: true, force: true }); } };
}

test("ownership names reject SQL fragments and preserve unique worker IDs", () => {
  assert.notEqual(mutationDatabaseName(runId, "1"), mutationDatabaseName(runId, "3"));
  for (const [id, worker] of [["other", "1"], [runId, "1;drop"], [runId, "-1"], [runId, "01"]]) {
    assert.throws(() => mutationDatabaseName(id, worker));
  }
});

test("provisions and reuses only its recorded database through the maintenance database", async () => {
  const f = await fixture();
  try {
    const database = await provisionMutationDatabase(f.environment, f.createClient);
    assert.equal(database, mutationDatabaseName(runId, "12"));
    assert.equal(await provisionMutationDatabase(f.environment, f.createClient), database);
    assert.equal(f.queries.filter(([sql]) => sql.startsWith("CREATE")).length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, `${database}.json`), "utf8")), { runId, database });
    assert.ok(f.clients.every((client) => client.ended && client.config.database === "postgres"));
    assert.equal(f.clients[0].config.host, "test-postgres");
    assert.equal(f.clients[0].config.port, 55433);
    assert.equal(f.clients[0].config.user, "test-owner");
    await cleanupMutationDatabases(f.environment, f.createClient);
    assert.deepEqual([...f.databases].sort(), ["kestrel_playground", "kestrel_test", "postgres"]);
    assert.ok(f.queries.some(([sql]) => sql === `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
  } finally { await f.dispose(); }
});

test("refuses a pre-existing unowned database without recording or dropping it", async () => {
  const f = await fixture();
  try {
    const database = mutationDatabaseName(runId, "12");
    f.databases.add(database);
    await assert.rejects(provisionMutationDatabase(f.environment, f.createClient), /Refusing to adopt/u);
    assert.deepEqual(await readdir(f.directory), []);
    await cleanupMutationDatabases(f.environment, f.createClient);
    assert.equal(f.databases.has(database), true);
    assert.equal(f.clients.length, 1);
  } finally { await f.dispose(); }
});

test("validates every cleanup record before connecting or issuing destructive SQL", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "postgres.json"), JSON.stringify({ runId, database: "postgres" }));
    await assert.rejects(cleanupMutationDatabases(f.environment, f.createClient));
    assert.equal(f.clients.length, 0);
    assert.deepEqual(f.queries, []);
  } finally { await f.dispose(); }
});

test("retains ownership records when cleanup fails and still closes the maintenance client", async () => {
  const f = await fixture();
  try {
    const database = await provisionMutationDatabase(f.environment, f.createClient);
    const failureClient = f.createClient({ database: "postgres" });
    failureClient.query = async () => { throw new Error("drop failed"); };
    await assert.rejects(cleanupMutationDatabases(f.environment, () => failureClient), /drop failed/u);
    assert.equal(failureClient.ended, true);
    assert.deepEqual(await readdir(f.directory), [`${database}.json`]);
  } finally { await f.dispose(); }
});

test("removes new ownership when a competing creator wins CREATE DATABASE", async () => {
  const f = await fixture();
  try {
    const client = f.createClient({ database: "postgres" });
    client.query = async (sql) => {
      if (sql.startsWith("SELECT")) return { rowCount: 0 };
      throw Object.assign(new Error("duplicate database"), { code: "42P04" });
    };
    await assert.rejects(provisionMutationDatabase(f.environment, () => client), { code: "42P04" });
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(client.ended, true);
  } finally { await f.dispose(); }
});

test("wrapper preserves CLI arguments, output, exit status and cleanup after child closure", async () => {
  const signals = new EventEmitter();
  let options;
  let closed = false;
  let cleaned = false;
  const code = await runMutation(["--dryRunOnly", "--mutate", "src/example.ts"], {
    environment: { STRYKER_MUTATOR_WORKER: "inherited", KESTREL_TEST_DATABASE: "kestrel_test" }, signals,
    spawnChild(executable, args, received) {
      assert.equal(executable, process.execPath);
      assert.match(args[0], /bin\/stryker\.js$/u);
      assert.deepEqual(args.slice(1), ["run", "--dryRunOnly", "--mutate", "src/example.ts"]);
      options = received;
      const child = new EventEmitter();
      queueMicrotask(() => { closed = true; child.emit("close", 7, null); });
      return child;
    },
    async cleanup(environment) {
      assert.equal(closed, true);
      assert.equal(environment, options.env);
      cleaned = true;
      await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true });
    },
  });
  assert.equal(code, 7);
  assert.equal(options.stdio, "inherit");
  assert.equal(options.detached, true);
  assert.match(options.env.KESTREL_MUTATION_RUN_ID, /^[a-f0-9]{16}$/u);
  assert.equal(options.env.STRYKER_MUTATOR_WORKER, undefined);
  assert.equal(options.env.KESTREL_TEST_DATABASE, "kestrel_test");
  assert.equal(cleaned, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("wrapper forwards the first interruption to the CLI and repeats to its owned group", async () => {
  const signals = new EventEmitter();
  const killed = [];
  const code = await runMutation([], {
    environment: {}, signals,
    sendSignal(pid, signal) { killed.push([pid, signal]); },
    async terminateGroup(pid) { assert.equal(pid, 4321); },
    spawnChild() {
      const child = new EventEmitter();
      child.pid = 4321;
      child.kill = (signal) => { killed.push(signal); queueMicrotask(() => child.emit("close", null, signal)); };
      queueMicrotask(() => { signals.emit("SIGINT"); signals.emit("SIGTERM"); });
      return child;
    },
    async cleanup(environment) { await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true }); },
  });
  assert.deepEqual(killed, ["SIGINT", [-4321, "SIGTERM"]]);
  assert.equal(code, 130);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("owned descendants are stopped before database cleanup", async () => {
  const order = [];
  await runMutation([], {
    environment: {}, signals: new EventEmitter(),
    spawnChild() {
      const child = Object.assign(new EventEmitter(), { pid: 4321 });
      queueMicrotask(() => { order.push("CLI closed"); child.emit("close", 0, null); });
      return child;
    },
    async terminateGroup(pid) { assert.equal(pid, 4321); order.push("descendants stopped"); },
    async cleanup(environment) {
      order.push("databases cleaned");
      await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true });
    },
  });
  assert.deepEqual(order, ["CLI closed", "descendants stopped", "databases cleaned"]);
});

test("process group cleanup escalates TERM to KILL and accepts disappearance", async () => {
  const signals = [];
  let alive = true;
  await terminateMutationProcessGroup(4321, {
    async wait() {},
    sendSignal(pid, signal) {
      assert.equal(pid, -4321);
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal) signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await terminateMutationProcessGroup(4321, {
    sendSignal() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
  for (const pid of [0, -1, undefined]) await assert.rejects(terminateMutationProcessGroup(pid), /Invalid owned/u);
  await assert.rejects(terminateMutationProcessGroup(4321, {
    sendSignal() {}, async wait() {},
  }), /descendants remain active/u);
});

test("a real detached process group stops its descendant before cleanup completes", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.on("SIGTERM", () => {
      if (descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
      descendant.once("exit", () => process.exit(0));
    });
    process.stdout.write("ready");
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    await terminateMutationProcessGroup(child.pid);
    await closed;
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  } finally {
    // Retain cleanup even when an assertion fails; only this detached group is addressed.
    await terminateMutationProcessGroup(child.pid);
    await closed;
  }
});

test("a real CLI receives SIGINT through the wrapper and exits before cleanup", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const signals = new EventEmitter();
  let cleaned = false;
  const code = await runMutation([], {
    environment: {}, signals,
    spawnChild(executable, args, options) {
      const child = spawn(executable, ["-e", `
        process.on("SIGINT", () => process.exit(130));
        process.stdout.write("ready");
        setInterval(() => {}, 1000);
      `], { ...options, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.once("data", () => signals.emit("SIGINT"));
      return child;
    },
    async cleanup(environment) {
      cleaned = true;
      await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true });
    },
  });
  assert.equal(code, 130);
  assert.equal(cleaned, true);
});

test("active descendants prevent database cleanup and preserve the recovery manifest", async () => {
  let directory;
  let cleaned = false;
  try {
    await assert.rejects(runMutation([], {
      environment: {}, signals: new EventEmitter(),
      spawnChild(executable, args, options) {
        directory = options.env.KESTREL_MUTATION_DATABASE_MANIFEST;
        const child = Object.assign(new EventEmitter(), { pid: 4321 });
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      async terminateGroup() { throw new Error("descendants active"); },
      async cleanup() { cleaned = true; },
    }), (error) => error.message === "descendants active" && error.mutationDatabaseManifest === directory);
    assert.equal(cleaned, false);
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

test("unsupported process-group platforms fail before spawning", async () => {
  await assert.rejects(runMutation([], {
    platform: "win32", spawnChild() { assert.fail("Must not spawn"); },
  }), /requires POSIX/u);
});

test("wrapper cleans its manifest after a child spawn error", async () => {
  let cleaned = false;
  await assert.rejects(runMutation([], {
    environment: {}, signals: new EventEmitter(),
    spawnChild() { throw new Error("spawn failed"); },
    async cleanup(environment) {
      cleaned = true;
      await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true });
    },
  }), /spawn failed/u);
  assert.equal(cleaned, true);
});

test("wrapper preserves the manifest location when cleanup fails", async () => {
  let directory;
  try {
    await assert.rejects(runMutation([], {
      environment: {}, signals: new EventEmitter(),
      spawnChild() {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      async cleanup(environment) {
        directory = environment.KESTREL_MUTATION_DATABASE_MANIFEST;
        throw new Error("cleanup failed");
      },
    }), (error) => error.message === "cleanup failed" && error.mutationDatabaseManifest === directory);
    assert.deepEqual(await readdir(directory), []);
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});
