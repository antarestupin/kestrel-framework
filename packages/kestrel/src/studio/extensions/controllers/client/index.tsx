import {
  useEffect,
  useMemo,
  useState,
} from "react";

import { createUuid } from "../../../../utils/uuid.js";
import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import { Icon } from "../../../client/src/ui/icon.js";
import {
  CONTROLLERS_STUDIO_PAGE_KIND,
  type StudioHttpControllerCatalog,
  type StudioHttpControllerCatalogNode,
  type StudioHttpControllerDefinition,
  type StudioHttpControllerInput,
  type StudioHttpControllerObservability,
  type StudioJsonSchema,
} from "../contract.js";
import { ExecutionDetails } from "../../observability/client/execution_details.js";
import "./styles.css";

type CatalogResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: StudioHttpControllerCatalog };

interface RequestResult {
  status: number;
  statusText: string;
  durationMs: number;
  headers: string;
  body: string;
}

const controllersStudioPageRenderer: StudioPageRenderer = {
  kind: CONTROLLERS_STUDIO_PAGE_KIND,
  render: (page) => <ControllersStudioPage page={page} />,
};

addStudioPageRenderer(controllersStudioPageRenderer);

function ControllersStudioPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page controllers-page">
      <StudioPageHeader page={page} eyebrow="HTTP" badge="Interactive" />
      {page.dataPath === undefined
        ? <p className="error-panel">The controllers page has no data endpoint.</p>
        : <ControllerExplorer dataPath={page.dataPath} />}
    </div>
  );
}

function ControllerExplorer({ dataPath }: { dataPath: string }) {
  const resource = useControllerCatalog(dataPath);
  const [selectedId, setSelectedId] = useState<string>();

  const controllers = useMemo(
    () => resource.status === "ready"
      ? flattenControllers(resource.catalog.nodes)
      : [],
    [resource],
  );

  useEffect(() => {
    if (controllers.length > 0 && !controllers.some(
      (controller) => controller.id === selectedId,
    )) {
      setSelectedId(controllers[0]!.id);
    }
  }, [controllers, selectedId]);

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading HTTP controllers…</p>;
  }

  if (resource.status === "error") {
    return <p className="error-panel">{resource.message}</p>;
  }

  if (controllers.length === 0) {
    return <p className="empty-state">No HTTP controller is registered.</p>;
  }

  const selectedController = controllers.find(
    (controller) => controller.id === selectedId,
  ) ?? controllers[0]!;

  return (
    <section className="controller-explorer" aria-label="HTTP controller explorer">
      <aside className="controller-tree">
        <header>{controllers.length} controllers</header>
        <nav aria-label="HTTP controller catalog">
          {resource.catalog.nodes.map((node) => (
            <ControllerTreeNode
              key={node.id}
              node={node}
              selectedId={selectedController.id}
              onSelect={setSelectedId}
            />
          ))}
        </nav>
      </aside>
      <ControllerRequestEditor
        controller={selectedController}
        key={selectedController.id}
        {...(resource.catalog.observability === undefined
          ? {}
          : { observability: resource.catalog.observability })}
      />
    </section>
  );
}

function ControllerTreeNode({
  node,
  selectedId,
  onSelect,
}: {
  node: StudioHttpControllerCatalogNode;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (node.kind === "group") {
    return (
      <details className="controller-tree-group" open>
        <summary>{node.name}</summary>
        <div>
          {node.children.map((child) => (
            <ControllerTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    );
  }

  return (
    <button
      className={node.id === selectedId ? "selected" : undefined}
      onClick={() => onSelect(node.id)}
      type="button"
    >
      <span className={`controller-method method-${node.method.toLowerCase()}`}>
        {node.method}
      </span>
      <span>{node.name}</span>
    </button>
  );
}

function ControllerRequestEditor({
  controller,
  observability,
}: {
  controller: StudioHttpControllerDefinition;
  observability?: StudioHttpControllerObservability;
}) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(
    () => createFieldValues(controller, 0),
  );
  const [body, setBody] = useState(
    () => createBodyValue(controller, 0),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<RequestResult>();
  const [executionId, setExecutionId] = useState<string>();
  const urlInputs = controller.inputs.filter(
    (input) => input.binding !== "body",
  );
  const bodyInputs = controller.inputs.filter(
    (input) => input.binding === "body",
  );

  const selectExample = (index: number) => {
    setExampleIndex(index);
    setFieldValues(createFieldValues(controller, index));
    setBody(createBodyValue(controller, index));
    setError(undefined);
    setResult(undefined);
    setExecutionId(undefined);
  };

  const send = async () => {
    setSending(true);
    setError(undefined);
    setResult(undefined);
    setExecutionId(undefined);

    try {
      const requestedExecutionId = observability === undefined
        ? undefined
        : createUuid();
      const request = buildRequest(
        controller,
        fieldValues,
        body,
        requestedExecutionId === undefined || observability === undefined
          ? undefined
          : {
              header: observability.executionIdHeader,
              value: requestedExecutionId,
            },
      );

      setExecutionId(requestedExecutionId);

      const startedAt = performance.now();
      const response = await fetch(request.url, request.init);
      const responseBody = await response.text();
      const responseExecutionId = observability === undefined
        ? null
        : response.headers.get(observability.executionIdHeader);

      if (responseExecutionId !== null) {
        setExecutionId(responseExecutionId);
      }

      setResult({
        status: response.status,
        statusText: response.statusText,
        durationMs: performance.now() - startedAt,
        headers: formatHeaders(response.headers),
        body: formatResponseBody(responseBody),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="controller-request-editor">
      <header className="controller-route-heading">
        <div>
          <span className={`controller-method method-${controller.method.toLowerCase()}`}>
            {controller.method}
          </span>
          <code>{controller.url}</code>
        </div>
        <small>{controller.id}</small>
        <small>Access: {controller.access}</small>
        {controller.description !== undefined && <p>{controller.description}</p>}
      </header>

      {controller.examples.length > 0 && (
        <label className="controller-example-picker">
          <span>Example</span>
          <select
            onChange={(event) => selectExample(Number(event.target.value))}
            value={exampleIndex}
          >
            {controller.examples.map((example, index) => (
              <option key={`${example.name}:${index}`} value={index}>
                {example.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {urlInputs.length > 0 && (
        <section className="controller-input-section">
          <h2>URL values</h2>
          <div className="controller-fields">
            {urlInputs.map((input) => (
              <label key={input.name}>
                <span>
                  {input.sourceName}
                  <small>{input.binding}{input.required ? " · required" : ""}</small>
                </span>
                <input
                  onChange={(event) => setFieldValues((values) => ({
                    ...values,
                    [input.name]: event.target.value,
                  }))}
                  placeholder={getSchemaLabel(input.schema)}
                  type="text"
                  value={fieldValues[input.name] ?? ""}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      {bodyInputs.length > 0 && (
        <section className="controller-input-section">
          <h2>JSON payload</h2>
          <textarea
            aria-label="JSON payload"
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
            value={body}
          />
        </section>
      )}

      <div className="controller-send-row">
        <button disabled={sending} onClick={() => void send()} type="button">
          <Icon name={sending ? "loading" : "play"} spin={sending} />
          {sending ? "Sending…" : "Send request"}
        </button>
        {error !== undefined && <p>{error}</p>}
      </div>

      {result !== undefined && (
        <ControllerResponse result={result} />
      )}
      {observability !== undefined && executionId !== undefined && (
        <section className="controller-observations">
          <ExecutionDetails
            dataPath={observability.dataPath}
            executionId={executionId}
            key={executionId}
            pollUntilCompleted
            requestPending={sending}
          />
        </section>
      )}
    </article>
  );
}

function ControllerResponse({ result }: { result: RequestResult }) {
  return (
    <section className="controller-response">
      <header>
        <h2>Response</h2>
        <span className={result.status >= 400 ? "failure" : "success"}>
          {result.status} {result.statusText}
        </span>
        <small>{Math.round(result.durationMs)} ms</small>
      </header>
      <details>
        <summary>Headers</summary>
        <pre>{result.headers}</pre>
      </details>
      <pre>{result.body === "" ? "(empty response)" : result.body}</pre>
    </section>
  );
}

function useControllerCatalog(dataPath: string): CatalogResource {
  const [resource, setResource] = useState<CatalogResource>({ status: "loading" });

  useEffect(() => {
    const abortController = new AbortController();

    void fetch(dataPath, {
      headers: { accept: "application/json" },
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load HTTP controllers (${response.status}).`);
        }

        return response.json() as Promise<StudioHttpControllerCatalog>;
      })
      .then((catalog) => setResource({ status: "ready", catalog }))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }

        setResource({
          status: "error",
          message: caught instanceof Error ? caught.message : String(caught),
        });
      });

    return () => abortController.abort();
  }, [dataPath]);

  return resource;
}

function flattenControllers(
  nodes: readonly StudioHttpControllerCatalogNode[],
): readonly StudioHttpControllerDefinition[] {
  return nodes.flatMap((node) =>
    node.kind === "controller"
      ? [node]
      : flattenControllers(node.children));
}

function createFieldValues(
  controller: StudioHttpControllerDefinition,
  exampleIndex: number,
): Record<string, string> {
  const input = controller.examples[exampleIndex]?.input ?? {};

  return Object.fromEntries(controller.inputs
    .filter((field) => field.binding !== "body")
    .map((field) => [field.name, formatRequestValue(input[field.name])]));
}

function createBodyValue(
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

function buildRequest(
  controller: StudioHttpControllerDefinition,
  fieldValues: Readonly<Record<string, string>>,
  body: string,
  correlation?: { header: string; value: string },
): { url: string; init: RequestInit } {
  let url = controller.url;
  const queryParameters = new URLSearchParams();
  const bodyInputs = controller.inputs.filter((input) => input.binding === "body");

  for (const input of controller.inputs) {
    const value = fieldValues[input.name] ?? "";

    if (input.binding === "path") {
      if (input.required && value === "") {
        throw new Error(`Path value "${input.sourceName}" is required.`);
      }

      url = url.replace(`:${input.sourceName}`, encodeURIComponent(value));
    } else if (input.binding === "query" && value !== "") {
      queryParameters.set(input.sourceName, value);
    }
  }

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

function getSchemaLabel(schema: StudioJsonSchema): string {
  if (typeof schema === "boolean") {
    return "value";
  }

  if (typeof schema.format === "string") {
    return schema.format;
  }

  return typeof schema.type === "string" ? schema.type : "value";
}

function formatHeaders(headers: Headers): string {
  return [...headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function formatResponseBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
