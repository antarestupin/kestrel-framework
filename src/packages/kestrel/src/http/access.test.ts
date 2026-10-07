import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { defineHttpAccessPolicy } from "./access.js";
import { defineHttpController, defineActionHttpController } from "./controller.js";
import { defineHttpMiddleware } from "./middleware.js";
import { get } from "./route.js";

describe("HTTP access policies", () => {
  it("requires a stable non-empty name", () => {
    expect(() => defineHttpAccessPolicy("  ")).toThrow(
      "An HTTP access policy name cannot be empty.",
    );
  });

  it("retains the explicit middleware declaration", () => {
    const middleware = defineHttpMiddleware("test.access", {
      handler: (_context, next) => next(),
    });
    const policy = defineHttpAccessPolicy("test.restricted", [middleware]);

    expect(policy).toEqual({
      name: "test.restricted",
      middleware: [middleware],
    });
  });

  it.each([null, {}, { name: "", middleware: [] }, { name: "invalid", middleware: null }])("rejects malformed explicit access (%s)", (access) => {
    expect(() => defineHttpController({
      access,
      route: get("/invalid-access"),
      handler: () => undefined,
    } as never)).toThrow(
      "An HTTP controller requires a valid access policy.",
    );
    const action = defineAction({
      name: "test.invalid-access",
      input: z.object({}),
      output: z.string(),
      handler: () => "unused",
    });
    expect(() => defineActionHttpController(action, get("/invalid-access"), {
      access,
    } as never)).toThrow("An HTTP controller requires a valid access policy.");
  });
});
