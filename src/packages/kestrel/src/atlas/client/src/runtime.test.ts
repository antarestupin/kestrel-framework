import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtlasManifest, AtlasOperationManifest, AtlasResourceManifest } from "../../contract.js";
import {
  AtlasGatewayError,
  coerceAtlasRecordId,
  coerceFormValue,
  describeFormInputSchema,
  executeAtlasRecordAction,
  executeAtlasOperation,
  getAtlasRedirectPath,
  getAtlasTargetPath,
  getRecordActionParameters,
  getRecordActionRoute,
  getResourceListFields,
  getResourcePath,
  getResourceRecordLabel,
  isRecordActionShownInList,
  readListResult,
} from "./runtime.js";

const operation: AtlasOperationManifest = {
  id: "user.fillName",
  sourceId: "application",
  effect: "write",
  inputs: [{ id: "id", required: true, schema: { type: "string" } }],
  outputSchema: { type: "object" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Atlas client runtime", () => {
  it("coerces only the numeric input bound to the route identity", () => {
    const mixed: AtlasOperationManifest = { ...operation, inputs: [
      { id: "unrelated", required: true, schema: { type: "integer" } },
      { id: "integerId", required: true, schema: { type: ["integer", "null"] } },
      { id: "decimalId", required: true, schema: { type: "number" } },
      { id: "stringId", required: true, schema: { type: "string", format: "date-time" } },
      { id: "unionId", required: true, schema: { type: ["string", "integer"] } },
    ] };
    expect(coerceAtlasRecordId("0", mixed, "integerId")).toBe(0);
    expect(coerceAtlasRecordId("2.5", mixed, "decimalId")).toBe(2.5);
    expect(coerceAtlasRecordId("", mixed, "integerId")).toBe("");
    expect(coerceAtlasRecordId("  ", mixed, "integerId")).toBe("  ");
    expect(coerceAtlasRecordId("Infinity", mixed, "integerId")).toBe("Infinity");
    expect(coerceAtlasRecordId("2026-01-01", mixed, "stringId")).toBe("2026-01-01");
    expect(coerceAtlasRecordId("02", mixed, "unionId")).toBe("02");
    expect(coerceAtlasRecordId("02", mixed, "absent")).toBe("02");
    expect(coerceAtlasRecordId("02", undefined, "integerId")).toBe("02");
  });

  it.each([
    ["2.5", { type: "number" }, 2.5],
    ["0", { type: "integer" }, 0],
    ["7", { type: ["null", "integer"] }, 7],
    ["7", { oneOf: [{ type: "null" }, { type: "integer" }] }, 7],
    ["1e1000", { type: "number" }, "1e1000"],
    ["NaN", { type: "integer" }, "NaN"],
    ["02", { type: "string" }, "02"],
  ] as const)("preserves or converts the scalar %s according to its input schema", (value, schema, expected) => {
    expect(coerceFormValue(value, schema)).toBe(expected);
  });

  it("retains a nullable schema with an unconstrained alternative", () => {
    const schema = { anyOf: [true, { type: "null" }] };
    expect(describeFormInputSchema(schema)).toStrictEqual({ schema, nullable: true });
  });

  it("executes manifest operations through the generic gateway", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        data: { id: "user-1", name: "Brave Otter" },
        effects: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await executeAtlasOperation<{ name: string }>(
      "/atlas",
      operation,
      { id: "user-1" },
    );

    expect(result).toEqual({ id: "user-1", name: "Brave Otter" });
    expect(fetch).toHaveBeenCalledWith(
      "/atlas/api/operations/user.fillName",
      expect.objectContaining({
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ input: { id: "user-1" } }),
      }),
    );
  });

  it.each(["record", "array", "list"])("materializes %s labels without another HTTP request", async (shape) => {
    const row = { id: "one" };
    const data = shape === "array" ? [row] : shape === "list" ? { items: [row] } : row;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data, effects: [], display: { shape, labels: ["Formatted"] } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await executeAtlasOperation<any>("/atlas", operation);
    const record = shape === "array" ? result[0] : shape === "list" ? result.items[0] : result;
    expect(record).toEqual({ id: "one", __atlas_display: "Formatted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains gateway failure details", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(executeAtlasOperation("/atlas", operation, {}))
      .rejects.toEqual(expect.objectContaining<Partial<AtlasGatewayError>>({
        operationId: "user.fillName",
        status: 404,
        body: { error: "Not found" },
      }));
  });

  it("keeps empty, plain text and problem JSON gateway failures distinguishable", async () => {
    const untypedResponse = new Response("Temporarily unavailable", { status: 503 });
    untypedResponse.headers.delete("content-type");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(untypedResponse)
      .mockResolvedValueOnce(new Response('{"detail":"Conflict"}', {
        status: 409, headers: { "content-type": "application/problem+json" },
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(executeAtlasOperation("/", operation)).rejects.toMatchObject({ status: 401, body: undefined });
    await expect(executeAtlasOperation("/", operation)).rejects.toMatchObject({ status: 503, body: "Temporarily unavailable" });
    await expect(executeAtlasOperation("/", operation)).rejects.toMatchObject({ status: 409, body: { detail: "Conflict" } });
    expect(fetch).toHaveBeenNthCalledWith(1, `/api/operations/${operation.id}`, expect.objectContaining({ body: '{"input":{}}' }));
  });

  it("keeps the HTTP status when an intermediary returns malformed problem JSON", async () => {
    const response = new Response("<html>Bad Gateway</html>", {
      status: 502, headers: { "content-type": "application/problem+json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(executeAtlasOperation("/atlas", operation)).rejects.toMatchObject({
      name: "AtlasGatewayError", status: 502, body: "<html>Bad Gateway</html>",
    });
  });

  it("reads JSON media types case-insensitively and ignores parameters when matching", async () => {
    const body = '{"data":{"id":"one"},"effects":[]}';
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(body, {
        headers: { "content-type": "Application/Problem+JSON ; charset=utf-8" },
      }))
      .mockResolvedValueOnce(new Response(body, {
        headers: { "content-type": 'text/plain; description="application/json"' },
      }));
    vi.stubGlobal("fetch", fetch);
    await expect(executeAtlasOperation("/atlas", operation)).resolves.toEqual({ id: "one" });
    await expect(executeAtlasOperation("/atlas", operation)).rejects.toThrow("invalid gateway response");
  });

  it("preserves the syntax failure for malformed successful JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid JSON", {
      headers: { "content-type": "application/json" },
    })));
    await expect(executeAtlasOperation("/atlas", operation)).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    [null, "invalid gateway response"],
    [{ effects: [] }, "invalid gateway response"],
    [{ data: {} }, "invalid gateway response"],
    [{ data: {}, effects: [], display: { shape: "array", labels: [] } }, "Invalid Atlas display metadata"],
    [{ data: { items: [] }, effects: [], display: { shape: "list", labels: ["Extra"] } }, "Invalid Atlas display metadata"],
    [{ data: [42], effects: [], display: { shape: "array", labels: ["Not a record"] } }, "Invalid Atlas display label"],
    [{ data: { id: "one" }, effects: [], display: { shape: "record", labels: [42] } }, "Invalid Atlas display label"],
  ] as const)("rejects invalid successful payload %j", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(executeAtlasOperation("/atlas", operation)).rejects.toThrow(message);
  });

  it("validates the list envelope and retains only record items", () => {
    expect(() => readListResult(null)).toThrow("invalid result");
    expect(() => readListResult({ items: {} })).toThrow("invalid result");
    expect(readListResult({ items: [null, "id", [], { id: "u1" }], pageInfo: null })).toEqual({
      items: [{ id: "u1" }], hasNextPage: false,
    });
    expect(readListResult({ items: [], pageInfo: { hasNextPage: true } }).hasNextPage).toBe(true);
    expect(readListResult({ items: [], pageInfo: { hasNextPage: "true" } }).hasNextPage).toBe(false);
  });

  it("derives record Action parameters and its canonical route", () => {
    const action = {
      id: "send-message",
      label: "Send message",
      recordInput: "id",
      presentation: "page" as const,
      action: {
        ...operation,
        inputs: [
          { id: "id", required: true, schema: { type: "string" } },
          { id: "message", required: true, schema: { type: "string" } },
        ],
      },
    };
    const resource = {
      id: "user",
      label: "Users",
      labelSingular: "User",
      identity: "id",
      displayField: "id",
      sourceId: "application",
      fields: [],
      capabilities: {
        list: operation,
        read: operation,
        readMany: operation,
        create: operation,
        update: operation,
        delete: operation,
      },
      views: [],
      recordActions: [action],
    };

    expect(getRecordActionParameters(action)).toEqual([
      expect.objectContaining({ id: "message" }),
    ]);
    expect(getRecordActionRoute(resource, "user/1", action))
      .toBe("/user/user%2F1/actions/send-message");
    expect(getResourceRecordLabel(
      { ...resource, displayField: "name" },
      { id: "user-1", name: "Ada" },
      "user-1",
    )).toBe("Ada");
  });

  it("executes record Actions through their exposure and resolves redirects", async () => {
    const action = {
      id: "copy",
      label: "Copy",
      recordInput: "id",
      presentation: "page" as const,
      action: operation,
    };
    const resource = {
      id: "user",
      label: "Users",
      labelSingular: "User",
      identity: "id",
      displayField: "id",
      sourceId: "application",
      fields: [],
      capabilities: {
        list: operation,
        read: operation,
        readMany: operation,
        create: operation,
        update: operation,
        delete: operation,
      },
      views: [],
      recordActions: [action],
    };
    const manifest = {
      basePath: "/atlas",
      title: "Atlas",
      defaults: { textMaxLength: 50, recordActionsInList: "all" as const },
      notifications: { position: "bottom-left" as const },
      icons: {},
      resources: [resource],
    };
    const response = {
      data: { id: "user-2" },
      effects: [{
        type: "redirect" as const,
        target: { resource: "user", recordId: "user/2" },
      }],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await executeAtlasRecordAction(
      "/atlas",
      resource,
      action,
      { id: "user-1" },
    );

    expect(result).toEqual(response);
    expect(getAtlasRedirectPath(manifest, result.effects))
      .toBe("/user/user%2F2");
    expect(getAtlasRedirectPath(manifest, [
      ...result.effects,
      { type: "redirect", target: { resource: "user", recordId: "next" } },
      { type: "notification", level: "success", message: "Copied" },
    ])).toBe("/user/next");
    expect(getAtlasRedirectPath(manifest, [{ type: "notification", level: "success", message: "Copied" }])).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/atlas/api/resources/user/record-actions/copy",
      expect.objectContaining({
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ input: { id: "user-1" } }),
      }),
    );

    fetch.mockResolvedValueOnce(Response.json({ error: "Duplicate name" }, { status: 409 }));
    await expect(executeAtlasRecordAction("/atlas", resource, action, { id: "user-1" })).rejects.toMatchObject({
      name: "AtlasGatewayError", operationId: "user.copy", status: 409, body: { error: "Duplicate name" },
      message: "Atlas operation user.copy failed with status 409.",
    });
  });

  it("resolves list visibility from the nearest configured policy", () => {
    const manifest = {
      basePath: "/atlas",
      title: "Atlas",
      defaults: { textMaxLength: 50, recordActionsInList: "none" as const },
      notifications: { position: "bottom-left" as const },
      icons: {},
      resources: [],
    };
    const resource = {
      id: "user",
      label: "Users",
      labelSingular: "User",
      identity: "id",
      displayField: "id",
      sourceId: "application",
      recordActionsInList: "all" as const,
      fields: [],
      capabilities: {
        list: operation,
        read: operation,
        readMany: operation,
        create: operation,
        update: operation,
        delete: operation,
      },
      views: [],
      recordActions: [],
    };
    const inheritedAction = {
      id: "fill-name",
      label: "Fill name",
      recordInput: "id",
      presentation: "page" as const,
      action: operation,
    };

    expect(isRecordActionShownInList(manifest, resource, inheritedAction))
      .toBe(true);
    expect(isRecordActionShownInList(manifest, resource, {
      ...inheritedAction,
      showInList: false,
    })).toBe(false);
    const { recordActionsInList: _listPolicy, ...resourceWithoutPolicy } = resource;
    expect(isRecordActionShownInList(manifest, resourceWithoutPolicy, inheritedAction)).toBe(false);
    expect(isRecordActionShownInList({ ...manifest, defaults: { ...manifest.defaults, recordActionsInList: "all" } }, {
      ...resource, recordActionsInList: "none",
    }, inheritedAction)).toBe(false);
    expect(isRecordActionShownInList(manifest, resourceWithoutPolicy, { ...inheritedAction, showInList: true })).toBe(true);
  });

  it("places the visible Resource display field first in lists", () => {
    const resource = {
      id: "user",
      label: "Users",
      labelSingular: "User",
      identity: "id",
      displayField: "name",
      sourceId: "application",
      fields: [
        { id: "id", label: "Id", kind: "id" as const, schema: {}, hidden: false, readOnly: true, searchable: false, filterOperators: [], sortable: false },
        { id: "email", label: "Email", kind: "email" as const, schema: {}, hidden: false, readOnly: false, searchable: false, filterOperators: [], sortable: false },
        { id: "name", label: "Name", kind: "text" as const, schema: {}, hidden: false, readOnly: false, searchable: false, filterOperators: [], sortable: false },
        { id: "secret", label: "Secret", kind: "text" as const, schema: {}, hidden: true, readOnly: false, searchable: false, filterOperators: [], sortable: false },
      ],
      capabilities: {
        list: operation,
        read: operation,
        readMany: operation,
        create: operation,
        update: operation,
        delete: operation,
      },
      views: [],
      recordActions: [],
    };

    expect(getResourceListFields(resource).map((field) => field.id))
      .toEqual(["name", "id", "email"]);
    expect(getResourceListFields({ ...resource, displayField: "secret" }).map((field) => field.id)).toEqual(["id", "email", "name"]);
    for (const record of [undefined, { name: null }, { name: "" }]) {
      expect(getResourceRecordLabel(resource, record, "fallback")).toBe("fallback");
    }
    expect(getResourceRecordLabel(resource, { name: 0 }, "fallback")).toBe("0");
    expect(getResourcePath("/", resource)).toBe("/user");
    expect(getResourcePath("/atlas", resource, "/create")).toBe("/atlas/user/create");
    const manifest: AtlasManifest = {
      basePath: "/", title: "Atlas", icons: {}, resources: [resource satisfies AtlasResourceManifest],
      defaults: { textMaxLength: 50, recordActionsInList: "none" }, notifications: { position: "bottom-left" },
    };
    expect(getAtlasRedirectPath(manifest, [])).toBeUndefined();
    expect(() => getAtlasTargetPath(manifest, { resource: "missing", recordId: "u1" })).toThrow("unknown Resource");
  });
});
