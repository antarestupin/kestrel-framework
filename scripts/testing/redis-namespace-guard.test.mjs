import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

import { guardRedisCommand, installRedisNamespaceGuard } from "./redis-namespace-guard.mjs";

const prefix = "kestrel:test:01234567-89ab-4cde-8fab-0123456789ab:";
const other = "kestrel:test:abcdef01-2345-4678-89ab-abcdef012345:";
const key = `${prefix}item`;
const blocked = { code: "KESTREL_TEST_REDIS_NAMESPACE" };

test("preserves every current test command and supports another test context's namespace", async () => {
  const commands = [
    ...["GET", "SET", "PEXPIRETIME", "PTTL", "PEXPIRE", "HEXISTS", "HLEN", "HSET", "HPEXPIRE", "HPEXPIRETIME", "ZCARD", "LPUSH"]
      .map((command) => [command, key, "value"]),
    ...["DEL", "UNLINK", "EXISTS"].map((command) => [command, key, `${other}item`]),
    ["EVAL", "return KEYS[1]", "1", key, "argument"], ["EVALSHA", "digest", "2", key, `${other}item`],
    ["EVAL", "return {}", "0"], ["EVALSHA", "digest", "0"],
    ["SCAN", "0", "MATCH", `${prefix}*`, "COUNT", "100"],
    ["HELLO", "2"], ["AUTH", "password"], ["PING"], ["QUIT"], ["CLIENT", "INFO"], ["SELECT", "2"],
    ["CLIENT", "SETNAME", "test-client"], ["CLIENT", "SETINFO", "LIB-NAME", "node-redis"],
    ["CLIENT", "SETINFO", "LIB-VER", "6.3.0"],
  ];
  const receiver = {};
  for (const args of commands) {
    let calls = 0;
    const options = { timeout: 100 };
    const result = Promise.resolve("reply");
    const send = guardRedisCommand(function (received, receivedOptions) {
      assert.equal(this, receiver);
      assert.equal(received, args);
      assert.equal(receivedOptions, options);
      calls += 1;
      return result;
    });
    assert.equal(send.call(receiver, args, options), result);
    assert.equal(calls, 1);
  }
});

test("rejects lost namespaces, unbounded scans and commands with undeclared key behavior", async () => {
  const send = guardRedisCommand(() => assert.fail("Blocked command reached the driver"));
  for (const args of [
    ["GET", "NaN"], ["SET", "application:item", "value"], ["DEL", key, "bare"], ["EXISTS", "bare", key],
    ["EVAL", "script", "2", key, "bare"], ["EVAL", "script", "3", key],
    ["EVALSHA", "digest", "1", "bare"], ["SCAN", "0"], ["SCAN", "0", "MATCH", "*"],
    ["SCAN", "0", "MATCH", `${prefix}*`, "MATCH", "*"], ["SELECT", "0"], ["SELECT", "3"],
    ["CLIENT", "KILL", "TYPE", "normal"], ["CLIENT", "SETINFO", "OTHER", "value"],
    ["FLUSHDB"], ["RENAME", key, "bare"], [],
  ]) await assert.rejects(send(args), blocked);
});

test("native eval and cache calls cross the shared prototype guard before driver queuing", async () => {
  const require = createRequire(import.meta.url);
  const { createClient, RedisClient, ClientClosedError } = require("@redis/client");
  installRedisNamespaceGuard();
  const installed = RedisClient.prototype.sendCommand;
  installRedisNamespaceGuard();
  assert.equal(RedisClient.prototype.sendCommand, installed);
  const client = createClient({ database: 2 });
  client.connect = () => assert.fail("Test must not connect");
  client._getQueue().addCommand = () => assert.fail("Blocked command must not reach the queue");
  await assert.rejects(client.eval("return KEYS[1]", { keys: ["bare"] }), blocked);
  await assert.rejects(client.evalSha("digest", { keys: ["bare"] }), blocked);
  await assert.rejects(client.get("NaN"), blocked);
  await assert.rejects(client.scan("0", { MATCH: "*" }), blocked);
  // An approved native command reaches the driver's existing closed-client rejection.
  await assert.rejects(client.eval("return KEYS[1]", { keys: [key] }), ClientClosedError);
  await assert.rejects(client.eval("return {}", { keys: [] }), ClientClosedError);
  const { RedisCacheAdapter } = await tsImport("../../src/packages/kestrel/src/cache/adapters/redis/adapter.ts", import.meta.url);
  const adapter = new RedisCacheAdapter(client, { keyPrefix: "application:", maxEntrySizeBytes: 1024 });
  await assert.rejects(adapter.get("item"), blocked);
  await assert.rejects(adapter.delete("item"), blocked);
  await assert.rejects(adapter.set("item", {
    value: "value", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), sizeBytes: 5, tags: [],
  }), blocked);
  let rawCommand;
  const fake = new RedisCacheAdapter({ sendCommand: async (args) => { rawCommand = args; return null; } }, {
    keyPrefix: "selected:", maxEntrySizeBytes: 1024,
  });
  assert.equal(await fake.get("item"), undefined);
  assert.deepEqual(rawCommand, ["GET", "selected:item"]);
});
