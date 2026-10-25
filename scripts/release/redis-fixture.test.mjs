import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { installRedisBootFixture } from "./redis-fixture.mjs";

/** Match the singleton registration and cleanup boundary used by installed applications. */
function fixtureApp(enabled = true) {
  let factory, options, client;
  return {
    container: {
      hasRegistration: (name) => enabled && name === "redis",
      registerFactory(name, create, settings) {
        assert.equal(name, "redis");
        assert.equal(settings.lifetime, "singleton");
        factory = create; options = settings;
      },
    },
    resolve() { assert(factory); return client ??= factory(); },
    async dispose() { if (client) await options.dispose(client); },
  };
}

test("the serialized Redis fixture exercises boot and disposal without socket access", async () => {
  // The verifier embeds this function in isolated child programs, without workspace imports.
  const install = runInNewContext(`(${installRedisBootFixture.toString()})`, { assert });
  const app = fixtureApp();
  const fixture = install(app);
  const client = app.resolve();
  assert.equal(client.isOpen, false);
  assert.equal(app.resolve(), client);
  await client.connect();
  assert.equal(client.isOpen, true);
  await app.dispose();
  await app.dispose();
  assert.equal(client.isOpen, false);
  fixture.verify();
});

test("the fixture leaves PostgreSQL-only consumers unchanged", async () => {
  const app = fixtureApp(false);
  const fixture = installRedisBootFixture(app);
  await app.dispose();
  fixture.verify();
});

test("the fixture detects unexpected Redis use even when callers swallow storage errors", async () => {
  for (const method of ["sendCommand", "eval"]) {
    const app = fixtureApp();
    const fixture = installRedisBootFixture(app);
    const client = app.resolve();
    await client.connect();
    await assert.rejects(client[method](), /must not execute Redis commands/);
    await app.dispose();
    assert.throws(() => fixture.verify(), /storage must remain untouched/);
  }
});

test("the fixture rejects missing boot or disposal instead of accepting a bypassed provider", async () => {
  const app = fixtureApp();
  const fixture = installRedisBootFixture(app);
  assert.throws(() => fixture.verify(), /Standard boot/);
  await app.resolve().connect();
  assert.throws(() => fixture.verify(), /Application disposal/);
  await app.dispose();
  fixture.verify();
});
