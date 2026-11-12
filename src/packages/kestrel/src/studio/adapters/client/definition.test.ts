import Fastify from "fastify";
import { expect, it, vi } from "vitest";

import { ViteDevelopmentRuntime } from "../../../client/index.js";
import { createDependencyContainer, dep, registerAdapter } from "../../../di/index.js";
import { Studio } from "../../studio.js";
import { ViteStudioClientAdapter } from "./adapter.js";
import { viteStudioClient } from "./definition.js";

it("constructs the packaged adapter without a development runtime", async () => {
  const container = createDependencyContainer({});
  const packaged = viteStudioClient({});
  const explicit = viteStudioClient(undefined, {});
  try {
    expect(registerAdapter(container, "packaged", packaged, undefined).get()).toBeInstanceOf(ViteStudioClientAdapter);
    expect(registerAdapter(container, "explicit", explicit, undefined).get()).toBeInstanceOf(ViteStudioClientAdapter);
  } finally {
    await container.dispose();
  }
});

it.each(["direct", "dependency"] as const)("borrows a %s runtime and safely injects the Studio configuration", async (mode) => {
  const container = createDependencyContainer({});
  const server = Fastify();
  const runtime = new ViteDevelopmentRuntime({ root: process.cwd(), configFile: "vite.config.ts" });
  const mount = vi.spyOn(runtime, "mount").mockResolvedValue(undefined);
  const transformHtml = vi.spyOn(runtime, "transformHtml").mockResolvedValue('<main data-config="__STUDIO_CLIENT_CONFIG__"></main>');
  const close = vi.spyOn(runtime, "close");
  const development = runtime.entry({ root: "studio-client" });
  const sourcePathMapping = { runtimeRoot: "/workspace/project", editorRoot: '/local/project"<&' };
  const dependency = dep<typeof development>("studioDevelopment");
  const resolveDevelopment = vi.fn(() => development);
  container.registerFactory(dependency.id, resolveDevelopment, { lifetime: "singleton" });

  try {
    const definition = viteStudioClient(mode === "dependency" ? dependency : development, { dev: true, sourcePathMapping });
    const registration = registerAdapter(container, "studioClient", definition, undefined);
    expect(resolveDevelopment).not.toHaveBeenCalled();

    // Mount and render against Fastify injection while Vite's server remains a test double.
    const render = await registration.get().setup(server, new Studio({ basePath: "/tools" }));
    server.get("/tools/logs", (_request, reply) => render(reply));
    const response = await server.inject("/tools/logs");
    expect(mount).toHaveBeenCalledOnce();
    expect(Object.is(mount.mock.calls[0]?.[0], server)).toBe(true);
    expect(transformHtml).toHaveBeenCalledExactlyOnceWith("/tools/logs", development.entry);
    expect(resolveDevelopment).toHaveBeenCalledTimes(mode === "dependency" ? 1 : 0);
    expect(response.headers["content-type"]).toContain("text/html");
    const config = response.body.match(/data-config="([^"]+)"/)?.[1];
    expect(JSON.parse(decodeURIComponent(config!))).toEqual({ basePath: "/tools", sourcePathMapping });
    expect(response.body).not.toContain(sourcePathMapping.editorRoot);

    await container.dispose();
    expect(close).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await container.dispose();
    await runtime.close();
  }
});
