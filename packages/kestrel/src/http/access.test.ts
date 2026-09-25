import { describe, expect, it } from "vitest";

import { defineHttpAccessPolicy } from "./access.js";
import { defineHttpController } from "./controller.js";
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

  it("rejects a missing policy at the runtime definition boundary", () => {
    expect(() => defineHttpController({
      route: get("/missing-access"),
      handler: () => undefined,
    } as never)).toThrow(
      "An HTTP controller requires a valid access policy.",
    );
  });
});
