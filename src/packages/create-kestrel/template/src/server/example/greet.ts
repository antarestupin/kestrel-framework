// Defines the example greeting action, input/output validation, and public HTTP route.
// Use this pattern for new operations and register them in example_catalog.ts.

import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { defineHttpAccessPolicy, defineActionHttpController, get } from "@kestreljs/framework/http";

/** A small business operation that can also be invoked without HTTP. */
export const greet = defineAction({
  name: "example.greet", input: z.object({ name: z.string().min(1) }),
  output: z.object({ message: z.string() }), dependencies: {},
  handler: ({ name }) => ({ message: `Hello, ${name}!` }),
});
// Derive the transport from the action so validation and behavior stay shared.
export const greetHttp = defineActionHttpController(greet, get("/api/greet"), defineHttpAccessPolicy("example.public"));
