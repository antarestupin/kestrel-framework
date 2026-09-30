import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { ViteDevelopmentRuntime, type ViteDevelopmentRuntimeOptions } from "@kestrel/framework/client";
import { createDevelopmentClients } from "./development_clients.js";

it("constructs one application runtime without starting Vite", async () => {
  const createServer = vi.fn(() => { throw new Error("Composition must not start Vite."); });
  const createRuntime = vi.fn((options: ViteDevelopmentRuntimeOptions) =>
    new ViteDevelopmentRuntime(options, { createServer }));
  const core = { runtimeRoot: resolve("."), projectRoot: resolve("."), debug: true };
  const clients = createDevelopmentClients({ core, client: { enabled: true, devMode: true } }, createRuntime);
  try {
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(clients.application?.entry.developmentModulePath).toBe("/src/client/src/main.tsx");
    expect(createServer).not.toHaveBeenCalled();
  } finally {
    await clients.application?.runtime.close();
  }
});

it.each([
  { enabled: false, devMode: true },
  { enabled: true, devMode: false },
])("skips the development runtime for $enabled/$devMode delivery", (client) => {
  const createRuntime = vi.fn(() => { throw new Error("Vite is disabled."); });
  const core = { runtimeRoot: resolve("."), projectRoot: resolve("."), debug: false };
  expect(createDevelopmentClients({ core, client }, createRuntime).application).toBeUndefined();
  expect(createRuntime).not.toHaveBeenCalled();
});
