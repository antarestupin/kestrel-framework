import Fastify from "fastify";
import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import { Studio } from "../../studio.js";
import { defineActionsDocumentationExtension } from "./extension.js";

describe("actions documentation Studio extension", () => {
  it("lists explicitly registered actions in name order", async () => {
    const server = Fastify();
    const extension = defineActionsDocumentationExtension([
      {
        name: "user.list",
        description: "List users.",
        middleware: [],
      },
      {
        name: "user.create",
        middleware: [{ name: "database.transaction" }],
      },
    ]);
    const studio = new Studio({ extensions: [extension] });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/actions-documentation/actions",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      actions: [
        {
          name: "user.create",
          middleware: ["database.transaction"],
        },
        {
          name: "user.list",
          description: "List users.",
          middleware: [],
        },
      ],
    });

    await server.close();
    await app.dispose();
  });

  it("rejects duplicate action names", () => {
    expect(() => defineActionsDocumentationExtension([
      { name: "example.run", middleware: [] },
      { name: "example.run", middleware: [] },
    ])).toThrow(
      'Action "example.run" is registered in Studio more than once.',
    );
  });
});
