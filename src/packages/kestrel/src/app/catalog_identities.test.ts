import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCliController } from "../cli/index.js";
import { defineWorker } from "../workers/worker.js";
import { App, defineCatalog } from "./index.js";

const ownedApps: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(ownedApps.splice(0).map((app) => app.dispose()));
});

/** Keep composed applications owned even when a duplicate contribution throws synchronously. */
function own<Application extends { dispose(): Promise<void> }>(app: Application): Application {
  ownedApps.push(app);
  return app;
}

function worker(name: string, queue: string) {
  return defineWorker({ name, queue, input: z.object({}), handler: () => undefined });
}

describe("AppCatalog runtime identities", () => {
  it("rejects distinct CLI definitions sharing one command without replacing the existing registration", () => {
    const first = defineCliController({ command: "catalog run", handler: () => undefined });
    const duplicate = defineCliController({ command: "catalog run", handler: () => undefined });
    const distinct = defineCliController({ command: "catalog inspect", handler: () => undefined });
    expect(duplicate).not.toBe(first);
    const app = own(new App({}, { catalog: defineCatalog({
      application: { controllers: { cli: { run: first } } },
    }) }));
    const before = [...app.catalog.cliControllers.registrations];

    // Different declaration paths must not hide a collision in the runtime command identity.
    expect(() => app.catalog.contribute({
      provider: { controllers: { cli: { execute: duplicate } } },
    }, { kind: "provider", provider: "DuplicateCommands" })).toThrow(TypeError);
    expect(app.catalog.cliControllers.registrations).toEqual(before);
    expect(app.catalog.cliControllers.definitions).toEqual([first]);
    expect(app.catalog.cliControllers.catalog).toEqual({ application: { run: first } });
    app.catalog.contribute({ provider: { controllers: { cli: { inspect: distinct } } } }, { kind: "provider", provider: "ValidCommands" });
    expect(app.catalog.cliControllers.definitions).toEqual([first, distinct]);
  });

  it("rejects distinct worker definitions sharing one queue without replacing its owner", () => {
    const first = worker("catalog.first", "catalog-shared-queue");
    const duplicate = worker("catalog.second", "catalog-shared-queue");
    const distinct = worker("catalog.third", "catalog-independent-queue");
    expect(duplicate).not.toBe(first);
    const app = own(new App({}, { catalog: defineCatalog({ application: { workers: { first } } }) }));
    const before = [...app.catalog.workers.registrations];

    // Worker display names differ; queue identity still selects a single worker definition.
    expect(() => app.catalog.contribute({
      provider: { workers: { second: duplicate } },
    }, { kind: "provider", provider: "DuplicateWorkers" })).toThrow(TypeError);
    expect(app.catalog.workers.registrations).toEqual(before);
    expect(app.catalog.workers.definitions).toEqual([first]);
    expect(app.catalog.workers.catalog).toEqual({ application: { first } });
    app.catalog.contribute({ provider: { workers: { third: distinct } } }, { kind: "provider", provider: "ValidWorkers" });
    expect(app.catalog.workers.definitions).toEqual([first, distinct]);
  });

  it("allows the same CLI declaration key in different branches when commands differ", () => {
    const first = defineCliController({ command: "catalog first", handler: () => undefined });
    const second = defineCliController({ command: "catalog second", handler: () => undefined });
    const app = own(new App({}, { catalog: defineCatalog({ first: { controllers: { cli: { run: first } } } }) }));
    app.catalog.contribute({ second: { controllers: { cli: { run: second } } } }, { kind: "provider", provider: "SecondCommands" });

    expect(app.catalog.cliControllers.definitions).toEqual([first, second]);
    expect(app.catalog.cliControllers.registrations).toMatchObject([
      { definition: first, path: ["first", "run"], source: { kind: "application" } },
      { definition: second, path: ["second", "run"], source: { kind: "provider", provider: "SecondCommands" } },
    ]);
    expect(app.catalog.cliControllers.catalog).toEqual({ first: { run: first }, second: { run: second } });
  });

  it("uses worker queues rather than display names or branch-local keys as identities", () => {
    const first = worker("catalog.display-name", "catalog-first-queue");
    const second = worker("catalog.display-name", "catalog-second-queue");
    const app = own(new App({}, { catalog: defineCatalog({ first: { workers: { job: first } } }) }));
    app.catalog.contribute({ second: { workers: { job: second } } }, { kind: "provider", provider: "SecondWorkers" });

    expect(app.catalog.workers.definitions).toEqual([first, second]);
    expect(app.catalog.workers.registrations).toMatchObject([
      { definition: first, path: ["first", "job"], source: { kind: "application" } },
      { definition: second, path: ["second", "job"], source: { kind: "provider", provider: "SecondWorkers" } },
    ]);
    expect(app.catalog.workers.catalog).toEqual({ first: { job: first }, second: { job: second } });
  });
});
