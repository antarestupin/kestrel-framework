import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  guardPostgresConnect,
  installPostgresDestinationGuard,
  resolvePostgresTestDestination,
} from "./postgres-destination-guard.mjs";

const destination = resolvePostgresTestDestination({});
const guardedCode = "KESTREL_TEST_POSTGRES_DESTINATION";
const clientFor = () => ({ ...destination, connectionParameters: { ...destination } });

test("resolves a frozen test destination independently of pg environment defaults", () => {
  assert.deepEqual(destination, {
    host: "localhost", port: 55432, user: "postgres", database: "kestrel_test",
  });
  assert.equal(Object.isFrozen(destination), true);
  assert.deepEqual(resolvePostgresTestDestination({
    DB_HOST: "postgres", DB_PORT: "5432", DB_USER: "test-owner",
    KESTREL_TEST_DATABASE: "dedicated", PGDATABASE: "application", PGPORT: "1",
  }), { host: "postgres", port: 5432, user: "test-owner", database: "dedicated" });
  assert.equal(resolvePostgresTestDestination({ KESTREL_POSTGRES_PORT: "55433" }).port, 55433);
  assert.throws(() => resolvePostgresTestDestination({ DB_PORT: "0" }), TypeError);
});

test("preserves the underlying driver's receiver, arguments and Promise result", async () => {
  const client = clientFor();
  const result = Promise.resolve(client);
  let calls = 0;
  const connect = guardPostgresConnect(function (...args) {
    calls += 1;
    assert.equal(this, client);
    assert.deepEqual(args, []);
    return result;
  }, destination);
  assert.equal(connect.call(client), result);
  assert.equal(await result, client);
  assert.equal(calls, 1);
  assert.deepEqual(client, clientFor());
});

test("preserves the underlying callback API for an approved destination", () => {
  const client = clientFor();
  const callback = () => {};
  const connect = guardPostgresConnect(function (received) {
    assert.equal(this, client);
    assert.equal(received, callback);
    return "driver-result";
  }, destination);
  assert.equal(connect.call(client, callback), "driver-result");
});

test("rejects every effective connection or startup coordinate before calling the driver", async () => {
  for (const source of ["client", "parameters"]) {
    for (const [key, value] of Object.entries({
      host: "foreign.invalid", port: 5432, user: "application", database: "application",
    })) {
      const client = clientFor();
      (source === "client" ? client : client.connectionParameters)[key] = value;
      let called = false;
      const connect = guardPostgresConnect(() => { called = true; }, destination);
      await assert.rejects(connect.call(client), { code: guardedCode });
      assert.equal(called, false, `${source}.${key} reached the driver`);
    }
  }
});

test("reports blocked callback connections asynchronously so pools can clean up", async () => {
  const client = clientFor();
  client.database = "application";
  let synchronous = true;
  const connect = guardPostgresConnect(() => assert.fail("Driver must not run"), destination);
  await new Promise((resolve, reject) => {
    assert.equal(connect.call(client, (error) => {
      try {
        assert.equal(synchronous, false);
        assert.equal(error.code, guardedCode);
        assert.equal(error.message.includes("application"), false);
        resolve();
      } catch (failure) { reject(failure); }
    }), undefined);
    synchronous = false;
  });
});

test("blocks pg connection-string overrides before any transport connection", async () => {
  const require = createRequire(import.meta.url);
  const pg = require("pg");
  installPostgresDestinationGuard({});
  const installed = pg.Client.prototype.connect;
  installPostgresDestinationGuard({});
  assert.equal(pg.Client.prototype.connect, installed);
  const client = new pg.Client({
    ...destination,
    connectionString: "postgresql://foreign:secret@foreign.invalid:5432/application",
  });
  assert.equal(client.host, "foreign.invalid");
  // This tripwire proves a real driver instance is rejected before opening a socket.
  client.connection.connect = () => assert.fail("Transport must not connect");
  await assert.rejects(client.connect(), { code: guardedCode });
  assert.equal(client._connecting, false);
});

test("lets a real pool remove a rejected client without opening its transport", async () => {
  const require = createRequire(import.meta.url);
  const pg = require("pg");
  installPostgresDestinationGuard({});
  class NoNetworkClient extends pg.Client {
    constructor(options) {
      super(options);
      this.connection.connect = () => assert.fail("Transport must not connect");
    }
  }
  const pool = new pg.Pool({
    Client: NoNetworkClient,
    host: "localhost", port: 5432, user: "postgres", database: "postgres",
  });
  try {
    await assert.rejects(pool.connect(), { code: guardedCode });
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
  } finally {
    await pool.end();
  }
});

test("blocks the undefined configuration returned by an empty provider mapping", async () => {
  const require = createRequire(import.meta.url);
  const pg = require("pg");
  installPostgresDestinationGuard({});
  const previousPort = process.env.PGPORT;
  process.env.PGPORT = "5432";
  try {
    const client = new pg.Client(undefined);
    assert.equal(client.port, 5432);
    client.connection.connect = () => assert.fail("Transport must not connect");
    await assert.rejects(client.connect(), { code: guardedCode });
    assert.equal(client._connecting, false);
  } finally {
    if (previousPort === undefined) delete process.env.PGPORT;
    else process.env.PGPORT = previousPort;
  }
});
