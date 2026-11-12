import type { StudioHttpControllerDefinition } from "../contract.js";

export function createFieldValues(
  controller: StudioHttpControllerDefinition,
  exampleIndex: number,
): Record<string, string> {
  const input = controller.examples[exampleIndex]?.input ?? {};

  return Object.fromEntries(controller.inputs
    .filter((field) => field.binding !== "body")
    .map((field) => [field.name, formatRequestValue(input[field.name])]));
}

export function createBodyValue(
  controller: StudioHttpControllerDefinition,
  exampleIndex: number,
): string {
  const input = controller.examples[exampleIndex]?.input ?? {};
  const payload = Object.fromEntries(controller.inputs
    .filter((field) => field.binding === "body")
    .flatMap((field) => input[field.name] === undefined
      ? []
      : [[field.sourceName, input[field.name]]]));

  return JSON.stringify(payload, null, 2);
}

export function buildRequest(
  controller: StudioHttpControllerDefinition,
  fieldValues: Readonly<Record<string, string>>,
  body: string,
  correlation?: { header: string; value: string },
): { url: string; init: RequestInit } {
  const pathValues = new Map<string, string>();
  const queryParameters = new URLSearchParams();
  const bodyInputs = controller.inputs.filter((input) => input.binding === "body");

  for (const input of controller.inputs) {
    const value = fieldValues[input.name] ?? "";

    if (input.binding === "path") {
      if (input.required && value === "") {
        throw new Error(`Path value "${input.sourceName}" is required.`);
      }

      if (value === "." || value === "..") {
        throw new Error(`Path value "${input.sourceName}" cannot be a dot segment.`);
      }

      pathValues.set(input.sourceName, pathValues.get(input.sourceName) ?? encodeURIComponent(value));
    } else if (input.binding === "query" && value !== "") {
      queryParameters.set(input.sourceName, value);
    }
  }

  // Substitute exact Fastify parameter names in one pass, including repeated uses.
  let url = controller.url.replace(
    /:([A-Za-z_][A-Za-z0-9_]*)/gu,
    (token: string, name: string) => pathValues.get(name) ?? token,
  );
  const query = queryParameters.toString();

  if (query !== "") {
    url += `${url.includes("?") ? "&" : "?"}${query}`;
  }

  if (controller.method === "GET" && bodyInputs.length > 0) {
    throw new Error("Browsers cannot send a body with a GET request.");
  }

  const hasBody = bodyInputs.length > 0;

  if (hasBody) {
    // Parse before sending so malformed payloads produce a local editor error.
    JSON.parse(body);
  }

  return {
    url,
    init: {
      method: controller.method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(correlation === undefined
          ? {}
          : { [correlation.header]: correlation.value }),
      },
      ...(hasBody ? { body } : {}),
    },
  };
}

function formatRequestValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}
