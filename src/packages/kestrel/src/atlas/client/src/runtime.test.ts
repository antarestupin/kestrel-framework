import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtlasOperationManifest } from "../../contract.js";
import {
  AtlasGatewayError,
  executeAtlasRecordAction,
  executeAtlasOperation,
  getAtlasRedirectPath,
  getRecordActionParameters,
  getRecordActionRoute,
  getResourceListFields,
  getResourceRecordLabel,
  isRecordActionShownInList,
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

    expect(result.name).toBe("Brave Otter");
    expect(fetch).toHaveBeenCalledWith(
      "/atlas/api/operations/user.fillName",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ input: { id: "user-1" } }),
      }),
    );
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
      defaults: { recordActionsInList: "all" as const },
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
    expect(fetch).toHaveBeenCalledWith(
      "/atlas/api/resources/user/record-actions/copy",
      expect.objectContaining({
        body: JSON.stringify({ input: { id: "user-1" } }),
      }),
    );
  });

  it("resolves list visibility from the nearest configured policy", () => {
    const manifest = {
      basePath: "/atlas",
      title: "Atlas",
      defaults: { recordActionsInList: "none" as const },
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
  });
});
