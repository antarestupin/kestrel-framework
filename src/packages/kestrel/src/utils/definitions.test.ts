import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { defineCliController } from "../cli/index.js";
import {
  defineHttpController,
  get,
} from "../http/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import { defineWorkflow } from "../workflows/index.js";
import {
  isAction,
  isCliController,
  isHttpController,
  isObject,
  isWorkflow,
} from "./definitions.js";

const action = defineAction({
  name: "example.read",
  input: z.object({}),
  output: z.string(),
  handler: () => "example",
});
const httpController = defineHttpController({
  access: testHttpAccess,
  route: get("/example"),
  handler: () => "example",
});
const cliController = defineCliController({
  command: "example read",
  handler: () => "example",
});
const workflow = defineWorkflow({
  name: "example.workflow",
  output: z.string(),
  handler: () => "example",
});

describe("definition guards", () => {
  it("recognizes Kestrel definition terminal values", () => {
    expect(isAction(action)).toBe(true);
    expect(isHttpController(httpController)).toBe(true);
    expect(isCliController(cliController)).toBe(true);
    expect(isWorkflow(workflow)).toBe(true);
  });

  it("does not confuse catalog branches or other definitions with leaves", () => {
    const branch = { example: action };

    expect(isAction(branch)).toBe(false);
    expect(isHttpController(branch)).toBe(false);
    expect(isCliController(branch)).toBe(false);
    expect(isHttpController(cliController)).toBe(false);
    expect(isCliController(httpController)).toBe(false);
    expect(isWorkflow(action)).toBe(false);
    expect(isAction(workflow)).toBe(false);
  });

  it("recognizes only non-null objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject("value")).toBe(false);
  });
});
