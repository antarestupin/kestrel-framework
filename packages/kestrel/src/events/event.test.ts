import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  defineEvent,
  isEventDefinition,
} from "./index.js";
import { flattenCatalog } from "../utils/index.js";

describe("event definitions", () => {
  it("rejects empty names", () => {
    expect(() => defineEvent({ name: "  ", schema: z.null() }))
      .toThrowError("An event name cannot be empty.");
  });

  it("can be collected from a nested export catalog", () => {
    const userCreated = defineEvent({
      name: "user.created",
      schema: z.object({ userId: z.string() }),
    });
    const invoicePaid = defineEvent({
      name: "invoice.paid",
      schema: z.object({ invoiceId: z.string() }),
    });
    const catalog = {
      user: { userCreated },
      billing: { invoicePaid },
    };

    expect(flattenCatalog(catalog, isEventDefinition)).toEqual([
      userCreated,
      invoicePaid,
    ]);
    expect(isEventDefinition({
      name: "not-an-event",
      schema: z.null(),
    })).toBe(false);
  });
});
