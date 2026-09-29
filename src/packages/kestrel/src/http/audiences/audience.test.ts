import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineHttpController } from "../controller.js";
import { get } from "../route.js";
import { testHttpAccess } from "../../testing/http_access.js";
import {
  defineHttpControllerAudiences,
  resolveHttpControllerAudiences,
} from "./audience.js";

const controllerAudiences = defineHttpControllerAudiences({
  audiences: ["app", "admin"],
  defaultAudiences: ["app"],
});

describe("HTTP controller audiences", () => {
  it("keeps defaults application-owned until catalog generation", () => {
    const controller = defineHttpController({
      access: testHttpAccess,
      route: get("/default"),
      output: z.null(),
      handler: () => null,
    });

    expect(controller.audiences).toBeUndefined();
    expect(
      resolveHttpControllerAudiences(
        controller.audiences,
        controllerAudiences,
      ),
    ).toEqual(["app"]);
    expect(controller.operationId).toBe("GET /default");
  });

  it("preserves explicit controller selections", () => {
    const controller = defineHttpController({
      access: testHttpAccess,
      route: get("/shared"),
      audiences: ["app", "admin"],
      output: z.null(),
      handler: () => null,
    });

    expect(controller.audiences).toEqual(["app", "admin"]);
  });

  it("validates application vocabularies and controller selections", () => {
    expect(() => defineHttpControllerAudiences({
      audiences: ["app", "app"],
      defaultAudiences: ["app"],
    })).toThrow("Duplicate HTTP controller available audience: app");
    expect(() => defineHttpControllerAudiences({
      audiences: ["app"],
      defaultAudiences: ["unknown"],
    } as never)).toThrow("Unknown default HTTP controller audience: unknown");
    expect(() => defineHttpController({
      access: testHttpAccess,
      route: get("/duplicate"),
      audiences: ["app", "app"],
      handler: () => undefined,
    })).toThrow("Duplicate HTTP controller selection audience: app");
  });

  it("rejects empty operation identifiers", () => {
    expect(() => defineHttpController({
      access: testHttpAccess,
      route: get("/invalid-operation"),
      operationId: "  ",
      handler: () => undefined,
    })).toThrow("operation identifier cannot be empty");
  });
});
