import { createRequire } from "node:module";

// Patch the same CommonJS prototype used by native Redis command methods.
const require = createRequire(import.meta.url);
const { RedisClient } = require("@redis/client");
const installedGuard = Symbol.for("kestrel.testing.redisNamespaceGuard");
const namespace = /^kestrel:test:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/u;
const singleKey = new Set([
  "GET", "SET", "PEXPIRETIME", "PTTL", "PEXPIRE", "HEXISTS", "HLEN", "HSET",
  "HPEXPIRE", "HPEXPIRETIME", "ZCARD", "LPUSH",
]);
const multipleKeys = new Set(["DEL", "UNLINK", "EXISTS"]);
const keyless = new Set(["HELLO", "AUTH", "PING", "QUIT"]);
const text = (value) => typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : undefined;

/** Inspect physical keys after native commands have serialized their arguments. */
export function guardRedisCommand(originalSendCommand) {
  return function guardedRedisCommand(args) {
    const command = text(args?.[0])?.toUpperCase();
    let keys;
    if (singleKey.has(command)) keys = [args[1]];
    else if (multipleKeys.has(command) && args.length > 1) keys = args.slice(1);
    else if (command === "EVAL" || command === "EVALSHA") {
      const count = text(args[2]);
      if (/^(?:0|[1-9]\d*)$/u.test(count ?? "") && Number(count) <= args.length - 3) {
        keys = args.slice(3, 3 + Number(count));
      }
    } else if (command === "SCAN") {
      // Require exactly one bounded MATCH; another MATCH could override the first one.
      const matches = args.flatMap((value, index) => text(value)?.toUpperCase() === "MATCH" ? [args[index + 1]] : []);
      if (matches.length === 1) keys = matches;
    } else if (keyless.has(command)
      || command === "CLIENT" && (
        args.length === 2 && text(args[1])?.toUpperCase() === "INFO"
        || args.length === 3 && text(args[1])?.toUpperCase() === "SETNAME"
        || args.length === 4 && text(args[1])?.toUpperCase() === "SETINFO"
          && ["LIB-NAME", "LIB-VER"].includes(text(args[2])?.toUpperCase())
      )
      || command === "SELECT" && args.length === 2 && text(args[1]) === "2") keys = [];
    if (!keys || !keys.every((key) => namespace.test(text(key) ?? ""))) {
      return Promise.reject(Object.assign(
        new Error("Kestrel tests blocked a Redis command outside the isolated test namespace."),
        { code: "KESTREL_TEST_REDIS_NAMESPACE" },
      ));
    }
    // Reject instead of rewriting so mutations that lose their prefix remain observable.
    return Reflect.apply(originalSendCommand, this, arguments);
  };
}

/** Persist across Vitest files without affecting fake clients used in unit tests. */
export function installRedisNamespaceGuard() {
  const prototype = RedisClient.prototype;
  if (prototype[installedGuard]) return;
  prototype.sendCommand = guardRedisCommand(prototype.sendCommand);
  Object.defineProperty(prototype, installedGuard, { value: true });
}
