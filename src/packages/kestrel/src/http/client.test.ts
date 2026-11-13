import Fastify from "fastify";
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
      {
        method: "GET",
        headers: expect.any(Headers),
      },
    );
    const request = fetchMock.mock.calls[0]?.[1];

    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request?.headers as Headers).get("authorization"))
      .toBe("Bearer token");
    expect((request?.headers as Headers).has("content-type")).toBe(false);
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
    const empty = new Response(null, { status: 204 });
    const readEmptyBody = vi.spyOn(empty, "text");
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(empty)
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
    expect(readEmptyBody).not.toHaveBeenCalled();
    await expect(transport.request(operation, { id: "missing" }))
      .rejects.toMatchObject({
        name: "HttpClientError",
        message: "HTTP operation space.delete failed with status 404.",
        operationId: "space.delete",
        status: 404,
        body: { message: "Missing" },
      });
  });

  it.each([undefined, null])("rejects missing values required by path bindings (%s)", async (id) => {
    const transport = createHttpClientTransport({
      baseUrl: "https://api.example.test",
      fetch: vi.fn() as typeof globalThis.fetch,
    });

    await expect(transport.request({
      operationId: "space.get",
      method: "GET",
      url: "/spaces/:id",
      bindings: [{ field: "id", kind: "path", name: "id" }],
    }, { id })).rejects.toThrow(
      "HTTP path input id is required for space.get.",
    );
  });

  it.each(["//other.example/records", "/\\other.example/records", "/\t/other.example/records"])(
    "rejects authority-like operation paths before fetching (%j)",
    async (url) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const headers = vi.fn(() => ({ authorization: "Bearer fixture" }));
      const transport = createHttpClientTransport({ baseUrl: "", fetch, headers });

      // Browser URL parsing can resolve these strings outside the page's origin.
      await expect(transport.request({ operationId: "record.read", method: "GET", url, bindings: [] }))
        .rejects.toThrow(/route URL/);
      expect(fetch).not.toHaveBeenCalled();
      expect(headers).not.toHaveBeenCalled();
    },
  );

  it.each([".", "..", ""])("rejects a path value that can change URL structure (%j)", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createHttpClientTransport({ baseUrl: "", fetch });

    await expect(transport.request({
      operationId: "record.read", method: "GET", url: "/:id/records",
      bindings: [{ field: "id", name: "id", kind: "path" }],
    }, { id })).rejects.toThrow(/path input|route URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads only explicit input properties and serializes prototype-like JSON keys", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const transport = createHttpClientTransport({ baseUrl: "", fetch });

    await expect(transport.request({
      operationId: "record.read", method: "GET", url: "/records/:id",
      bindings: [{ field: "constructor", name: "id", kind: "path" }],
    })).rejects.toThrow("HTTP path input constructor is required");
    expect(fetch).not.toHaveBeenCalled();

    // A declared wire property named __proto__ is ordinary JSON data.
    await transport.request({
      operationId: "record.write", method: "POST", url: "/records",
      bindings: [{ field: "value", name: "__proto__", kind: "body" }],
    }, { value: { enabled: true } });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"__proto__":{"enabled":true}}');
  });

  it("preserves status and the raw error body when the server sends malformed JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{invalid", {
      status: 502, statusText: "Bad Gateway", headers: { "content-type": "application/problem+json" },
    }));
    const transport = createHttpClientTransport({ baseUrl: "/api", fetch });

    await expect(transport.request({ operationId: "record.read", method: "GET", url: "/records", bindings: [] }))
      .rejects.toMatchObject({ name: "HttpClientError", status: 502, statusText: "Bad Gateway", body: "{invalid" });
  });

  it("decodes a structured JSON media type even with surrounding whitespace and parameters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"reason":"conflict"}', {
      status: 409, headers: { "content-type": "Application/Problem+JSON ; charset=utf-8" },
    }));
    const transport = createHttpClientTransport({ baseUrl: "/api", fetch });

    // Error responses retain the decoded payload and its original HTTP status.
    await expect(transport.request({ operationId: "record.read", method: "GET", url: "/records", bindings: [] }))
      .rejects.toMatchObject({ status: 409, body: { reason: "conflict" } });
  });

  it("appends dates and structured query values and preserves asynchronous header overrides", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"accepted":true}', {
      status: 200, headers: { "content-type": "Application/JSON; Charset=UTF-8" },
    }));
    const headers = vi.fn(async () => ({ "content-type": "application/vnd.example+json" }));
    const transport = createHttpClientTransport({ baseUrl: "/api", fetch, headers });
    const response = await transport.request({
      operationId: "record.search", method: "POST", url: "/records?scope=local",
      bindings: [
        { field: "filters", name: "filters", kind: "query" },
        { field: "since", name: "since", kind: "query" },
        { field: "flag", name: "flag", kind: "query" },
        { field: "ignored", name: "ignored", kind: "query" },
        { field: "name", name: "name", kind: "body" },
      ],
    }, { filters: { active: true }, since: new Date("2026-01-01T00:00:00Z"), flag: null, name: "example" });

    expect(response).toEqual({ accepted: true });
    expect(headers).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("/api/records?scope=local&filters=%7B%22active%22%3Atrue%7D&since=2026-01-01T00%3A00%3A00.000Z&flag=null");
    expect(new Headers(options?.headers).get("content-type")).toBe("application/vnd.example+json");
    expect(options?.body).toBe('{"name":"example"}');
  });

  it("falls back to the host fetch and distinguishes empty, plain and invalid JSON responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("plain")))
      .mockResolvedValueOnce(new Response("{invalid", { headers: { "content-type": "application/json" } }));
    const operation = { operationId: "record.read", method: "GET", url: "/records", bindings: [] } as const;
    vi.stubGlobal("fetch", fetch);
    try {
      const transport = createHttpClientTransport({ baseUrl: "" });
      await expect(transport.request(operation)).resolves.toBeUndefined();
      await expect(transport.request(operation)).resolves.toBe("plain");
      await expect(transport.request(operation)).rejects.toBeInstanceOf(SyntaxError);
      vi.stubGlobal("fetch", undefined);
      expect(() => createHttpClientTransport({ baseUrl: "" })).toThrow("fetch implementation is required");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a path binding with no matching route segment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createHttpClientTransport({ baseUrl: "/api", fetch });
    await expect(transport.request({
      operationId: "record.read", method: "GET", url: "/records/:other",
      bindings: [{ field: "id", name: "id", kind: "path" }],
    }, { id: "42" })).rejects.toThrow("HTTP path parameter id does not exist in route /records/:other");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces each complete occurrence of a repeated path parameter", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const transport = createHttpClientTransport({ baseUrl: "", fetch });
    await transport.request({
      operationId: "record.compare", method: "GET", url: "/compare/:id/with/:id/:idSuffix",
      bindings: [
        { field: "id", name: "id", kind: "path" },
        { field: "idSuffix", name: "idSuffix", kind: "path" },
      ],
    }, { id: "a/b", idSuffix: "edition" });
    expect(fetch).toHaveBeenCalledWith("/compare/a%2Fb/with/a%2Fb/edition", expect.any(Object));
  });

  it("binds a named parameter surrounded by literal route text and preserves existing query text", async () => {
    const server = Fastify();
    const route = "/prefix-:file.json";
    server.get(route, (request) => ({ params: request.params, query: request.query }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const response = await server.inject(String(url));
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    });
    const transport = createHttpClientTransport({ baseUrl: "", fetch });
    try {
      // The suffix can occur inside the bound value as well as in the route.
      await expect(transport.request({
        operationId: "record.read", method: "GET", url: `${route}?scope=:file`,
        bindings: [
          { field: "file", name: "file", kind: "path" },
        ],
      }, { file: "sample-file.json" })).resolves.toEqual({
        params: { file: "sample-file.json" },
        query: { scope: ":file" },
      });
    } finally {
      await server.close();
    }
  });

  it.each(["/:first-:second", "/:first([a-z]+).json"])(
    "rejects route patterns the generated client cannot interpolate (%s)", async (url) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const transport = createHttpClientTransport({ baseUrl: "", fetch });
      // Fastify can decode encoded delimiters before it separates adjacent parameters.
      await expect(transport.request({
        operationId: "record.read", method: "GET", url,
        bindings: [{ field: "first", name: "first", kind: "path" }],
      }, { first: "one" })).rejects.toThrow("HTTP path parameter first uses an unsupported route pattern.");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("renders escaped colons as literal route text without decoding interpolated values", async () => {
    const server = Fastify();
    const route = "/jobs::status/:id";
    server.get(route, (request) => request.params);
    server.get("/jobs::", () => ({ literal: true }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const response = await server.inject(String(url));
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    });
    try {
      const transport = createHttpClientTransport({ baseUrl: "", fetch });
      await expect(transport.request({
        operationId: "jobs.status", method: "GET", url: `${route}?literal=::`,
        bindings: [{ field: "id", name: "id", kind: "path" }],
      }, { id: "a::b" })).resolves.toEqual({ id: "a::b" });
      expect(fetch).toHaveBeenCalledWith("/jobs:status/a%3A%3Ab?literal=::", expect.any(Object));
      await expect(transport.request({ operationId: "jobs.literal", method: "GET", url: "/jobs::", bindings: [] }))
        .resolves.toEqual({ literal: true });
      expect(fetch).toHaveBeenLastCalledWith("/jobs:", expect.any(Object));
    } finally {
      await server.close();
    }
  });
});
