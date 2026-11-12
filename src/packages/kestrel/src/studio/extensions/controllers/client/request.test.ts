import { describe, expect, it } from "vitest";

import type { StudioHttpControllerDefinition } from "../contract.js";
import { buildRequest, createBodyValue, createFieldValues } from "./request.js";

const controller: StudioHttpControllerDefinition = {
  kind: "controller",
  id: "people.update",
  name: "Update person",
  method: "PATCH",
  url: "/:id2/people/:id/aliases/:id",
  access: "Test",
  inputs: [
    { name: "person", sourceName: "id", binding: "path", required: true, schema: { type: "string" } },
    { name: "team", sourceName: "id2", binding: "path", required: true, schema: { type: "string" } },
    { name: "show", sourceName: "include", binding: "query", required: false, schema: { type: "boolean" } },
    { name: "size", sourceName: "limit", binding: "query", required: false, schema: { type: "number" } },
    { name: "displayName", sourceName: "name", binding: "body", required: true, schema: { type: "string" } },
    { name: "options", sourceName: "options", binding: "body", required: false, schema: { type: "object" } },
  ],
  examples: [{ name: "Example", input: { person: "A/B", team: "team", show: false, size: null, displayName: "Ada" } }],
};

describe("Studio controller request editor", () => {
  it("replaces complete path parameters everywhere and applies logical bindings", () => {
    const fields = createFieldValues(controller, 0);
    const body = createBodyValue(controller, 0);
    expect(fields).toEqual({ person: "A/B", team: "team", show: "false", size: "" });
    expect(JSON.parse(body)).toEqual({ name: "Ada" });
    expect(buildRequest(controller, fields, body, { header: "x-correlation", value: "run-1" })).toEqual({
      url: "/team/people/A%2FB/aliases/A%2FB?include=false",
      init: {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-correlation": "run-1",
        },
        body,
      },
    });
  });

  it("rejects a missing required path value or invalid request body before sending", () => {
    expect(() => buildRequest(controller, createFieldValues(controller, 99), "{}")).toThrow(/Path value "id"/);
    expect(() => buildRequest(controller, createFieldValues(controller, 0), "not JSON")).toThrow(SyntaxError);
    expect(() => buildRequest({ ...controller, method: "GET" }, createFieldValues(controller, 0), "{}")).toThrow(/body with a GET/);
    expect(createBodyValue(controller, 99)).toBe("{}");
  });

  it("serializes query aliases and leaves bodyless requests without content headers", () => {
    const get = { ...controller, method: "GET", url: "/people", inputs: controller.inputs.slice(2, 4) } as const;
    expect(buildRequest(get, { show: "details & metadata", size: "5" }, "")).toEqual({
      url: "/people?include=details+%26+metadata&limit=5",
      init: { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } },
    });
  });

  it.each([".", ".."])("rejects a path value interpreted as a navigation segment (%s)", (person) => {
    expect(() => buildRequest(controller, { person, team: "team" }, "{}")).toThrow(/dot segment/);
  });
});
