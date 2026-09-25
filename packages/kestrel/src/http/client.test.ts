import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createHttpClientTransport,
  HttpClientError,
  type HttpClientOperation,
} from "./client.js";

describe("HTTP client transport", () => {
  it("maps logical controller input to path and query parameters", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) => new Response(
        JSON.stringify({ id: "space/one", page: 2 }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const transport = createHttpClientTransport({
      baseUrl: "https://api.example.test/",
      fetch: fetchMock,
      headers: { authorization: "Bearer token" },
    });
    const operation = {
      operationId: "space.getOverview",
      method: "GET",
      url: "/spaces/:spaceId/overview",
      bindings: [
        { field: "id", kind: "path", name: "spaceId" },
        { field: "page", kind: "query", name: "page" },
        { field: "tags", kind: "query", name: "tag" },
      ],
    } satisfies HttpClientOperation;

    const result = await transport.request(operation, {
      id: "space/one",
      page: 2,
      tags: ["open", "recent"],
    });

    expect(result).toEqual({ id: "space/one", page: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/spaces/space%2Fone/overview?page=2&tag=open&tag=recent",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];

    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request?.headers as Headers).get("authorization"))
      .toBe("Bearer token");
  });

  it("sends body bindings as JSON and returns text payloads", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async (_input, _init) => new Response("created", {
        status: 201,
        headers: { "content-type": "text/plain" },
      }),
    );
    const transport = createHttpClientTransport({
      baseUrl: "/api",
      fetch: fetchMock,
    });

    const result = await transport.request<string>({
      operationId: "space.create",
      method: "POST",
      url: "/spaces",
      bindings: [
        { field: "name", kind: "body", name: "displayName" },
      ],
    }, { name: "Agora" });

    expect(result).toBe("created");
    expect(fetchMock).toHaveBeenCalledWith("/api/spaces", {
      method: "POST",
      headers: expect.any(Headers),
      body: JSON.stringify({ displayName: "Agora" }),
    });
    const request = fetchMock.mock.calls[0]?.[1];

    expect((request?.headers as Headers).get("content-type"))
      .toBe("application/json");
  });

  it("returns void for empty responses and exposes HTTP error payloads", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "Missing" }),
        {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" },
        },
      ));
    const transport = createHttpClientTransport({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });
    const operation = {
      operationId: "space.delete",
      method: "DELETE",
      url: "/spaces/:id",
      bindings: [{ field: "id", kind: "path", name: "id" }],
    } satisfies HttpClientOperation;

    await expect(transport.request<void>(operation, { id: "known" }))
      .resolves.toBeUndefined();
    await expect(transport.request(operation, { id: "missing" }))
      .rejects.toMatchObject({
        name: "HttpClientError",
        operationId: "space.delete",
        status: 404,
        body: { message: "Missing" },
      });
  });

  it("rejects missing values required by path bindings", async () => {
    const transport = createHttpClientTransport({
      baseUrl: "https://api.example.test",
      fetch: vi.fn() as typeof globalThis.fetch,
    });

    await expect(transport.request({
      operationId: "space.get",
      method: "GET",
      url: "/spaces/:id",
      bindings: [{ field: "id", kind: "path", name: "id" }],
    }, {})).rejects.toThrow(
      "HTTP path input id is required for space.get.",
    );
  });
});
