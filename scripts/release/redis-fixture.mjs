import assert from "node:assert/strict";

/** Inject only Redis infrastructure; installed application providers still own standard boot. */
export function installRedisBootFixture(app) {
  const enabled = app.container.hasRegistration("redis");
  const calls = { connect: 0, commands: 0, destroy: 0 };
  const unexpectedCommand = async () => {
    calls.commands += 1;
    throw new Error("Browser verification must not execute Redis commands.");
  };
  if (enabled) {
    // Keep the native-client shape used by RedisProvider without opening a socket.
    app.container.registerFactory("redis", () => ({
      isOpen: false,
      async connect() { calls.connect += 1; this.isOpen = true; },
      destroy() { calls.destroy += 1; this.isOpen = false; },
      sendCommand: unexpectedCommand,
      eval: unexpectedCommand,
    }), {
      lifetime: "singleton",
      dispose: (client) => { if (client.isOpen) client.destroy(); },
    });
  }
  return {
    verify() {
      // Cache fail-open behavior must not hide unexpected storage access.
      assert.equal(calls.commands, 0, "Unused Redis storage must remain untouched.");
      assert.equal(calls.connect, enabled ? 1 : 0, "Standard boot must connect the selected native client once.");
      assert.equal(calls.destroy, enabled ? 1 : 0, "Application disposal must close the owned Redis client once.");
    },
  };
}
