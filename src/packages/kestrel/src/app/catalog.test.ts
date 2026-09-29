import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { defineCliController } from "../cli/index.js";
import { defineHttpController, get } from "../http/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import { defineWorkflow } from "../workflows/index.js";
import {
  App,
  defineCatalog,
  selectWorkflowCatalog,
} from "./index.js";

const createUser = defineAction({
  name: "user.create",
  input: z.object({ email: z.email() }),
  output: z.object({ id: z.string() }),
  handler: ({ email }) => ({ id: email }),
});

const onboardUser = defineWorkflow({
  name: "user.onboard",
  input: z.object({ userId: z.string() }),
  output: z.object({ completed: z.boolean() }),
  handler: () => ({ completed: true }),
});

describe("AppCatalog", () => {
  it("preserves typed declarations and derives homogeneous runtime indexes", () => {
    const declaration = defineCatalog({
      user: {
        actions: { create: createUser },
        workflows: { onboard: onboardUser },
      },
    });
    const app = new App({}, { catalog: declaration });

    expectTypeOf(declaration.user.actions.create).toEqualTypeOf(createUser);
    expect(app.catalog.declaration).toBe(declaration);
    expect(app.catalog.actions.definitions).toEqual([createUser]);
    expect(app.catalog.workflows.definitions).toEqual([onboardUser]);
    expectTypeOf(declaration.user.workflows.onboard)
      .toEqualTypeOf(onboardUser);
    const workflows = selectWorkflowCatalog(declaration);
    expect(workflows).toEqual({ user: { onboard: onboardUser } });
    expectTypeOf(workflows.user.onboard).toEqualTypeOf(onboardUser);
    expect(app.catalog.actions.registrations[0]).toMatchObject({
      path: ["user", "create"],
      source: { kind: "application" },
    });
  });

  it("rejects duplicate workflow identities across catalog branches", () => {
    const duplicate = defineWorkflow({
      name: "user.onboard",
      handler: () => undefined,
    });
    const app = new App({}, {
      catalog: defineCatalog({
        user: { workflows: { onboard: onboardUser } },
      }),
    });

    expect(() => app.catalog.contribute({
      administration: { workflows: { onboard: duplicate } },
    }, { kind: "provider", provider: "DuplicateProvider" }))
      .toThrow("Workflow identities must be unique");
  });

  it("accepts provider subcatalogs only during composition", async () => {
    const command = defineCliController({
      command: "example run",
      handler: () => undefined,
    });
    const app = new App({});

    app.catalog.contribute({
      example: { controllers: { cli: { run: command } } },
    }, { kind: "provider", provider: "ExampleProvider" });

    expect(app.catalog.cliControllers.registrations[0]).toMatchObject({
      definition: command,
      path: ["example", "run"],
      source: { kind: "provider", provider: "ExampleProvider" },
    });

    await app.start();

    expect(() => app.catalog.contribute({}, { kind: "application" }))
      .toThrow("only be contributed during composition");

    await app.dispose();
  });

  it("rejects misplaced definitions and ambiguous category identities", () => {
    expect(() => new App({}, {
      catalog: defineCatalog({ misplaced: createUser }),
    })).toThrow("must be declared below a definition category");

    const first = defineHttpController({
      access: testHttpAccess,
      route: get("/first"),
      handler: () => undefined,
    });
    const second = defineHttpController({
      access: testHttpAccess,
      route: get("/second"),
      handler: () => undefined,
    });
    const app = new App({}, {
      catalog: defineCatalog({
        first: {
          actions: { create: createUser },
          controllers: { http: { endpoint: first } },
        },
      }),
    });

    expect(() => app.catalog.contribute({
      second: { controllers: { http: { endpoint: second } } },
    }, { kind: "application" })).not.toThrow();

    expect(() => app.catalog.contribute({
      actions: { duplicate: createUser },
    }, { kind: "provider", provider: "DuplicateProvider" }))
      .toThrow("Action identities must be unique");
  });
});
