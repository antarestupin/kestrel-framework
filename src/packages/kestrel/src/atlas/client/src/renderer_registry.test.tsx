import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AtlasFieldManifest,
  AtlasOperationInputManifest,
  AtlasOperationManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  FieldValue,
  OperationControl,
  OperationInput,
} from "./pages.js";
import {
  AtlasRendererRegistryProvider,
  resolveAtlasRenderer,
} from "./renderer_registry.js";

const titleField: AtlasFieldManifest = {
  id: "title",
  label: "Title",
  kind: "text",
  schema: { type: "string" },
  hidden: false,
  readOnly: false,
  searchable: false,
  filterOperators: [],
  sortable: false,
};
const titleInput: AtlasOperationInputManifest = {
  id: "title",
  required: true,
  schema: { type: "string" },
};
const deleteOperation: AtlasOperationManifest = {
  id: "record.delete",
  sourceId: "application",
  effect: "destructive",
  inputs: [],
};

describe("atlas renderer registries", () => {
  it("resolves the first registered key", () => {
    const fallback = Symbol("fallback");
    const exact = Symbol("exact");

    expect(resolveAtlasRenderer(
      { text: fallback, title: exact },
      ["missing", "title", "text"],
    )).toBe(exact);
    expect(resolveAtlasRenderer({ text: fallback }, ["constructor", undefined, "text"])).toBe(fallback);
    expect(resolveAtlasRenderer(undefined, ["text"])).toBeUndefined();
  });

  it.each([
    ["checked", { type: "boolean" }, "boolean"],
    ["contact", { type: "string", format: "email" }, "email"],
    ["due", { type: "string", format: "date" }, "date"],
    ["at", { type: "string", format: "date-time" }, "datetime"],
    ["estimate", { type: "number" }, "number"],
    ["count", { type: "integer" }, "number"],
    ["BodyContent", { type: "string" }, "multiline"],
    ["Description", { type: "string" }, "multiline"],
    ["title", { type: "string" }, "text"],
    ["details", { type: "object" }, "json"],
  ] as const)("infers the %s input registry family", (id, schema, family) => {
    // Register every family so falling back to another family remains observable.
    const inputKeys = ["boolean", "email", "date", "datetime", "number", "multiline", "text", "json", "default"];
    const inputs = Object.fromEntries(inputKeys.map((key) => [key, () => <span data-family={key} />]));
    const html = renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{ inputs }}>
      <OperationInput definition={{ id, schema, required: false }} />
    </AtlasRendererRegistryProvider>);
    expect(html).toContain(`data-family="${family}"`);
  });

  it("prefers a Resource-qualified input and then falls back to the default override", () => {
    const resource = { id: "article" } as AtlasResourceManifest;
    const html = renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{ inputs: {
      "article.title": () => <mark>Qualified</mark>,
      default: () => <mark>Default</mark>,
    } }}>
      <OperationInput definition={titleInput} resource={resource} />
      <OperationInput definition={titleInput} />
    </AtlasRendererRegistryProvider>);
    expect(html).toBe("<mark>Qualified</mark><mark>Default</mark>");
  });

  it("resolves the default operation renderer inside the styled and disabled control", () => {
    const html = renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{
      operationControls: { default: ({ label }) => <mark>{label}</mark> },
    }}>
      <OperationControl label="Remove" operation={deleteOperation} pending presentation="primary" tone="danger" type="submit" />
    </AtlasRendererRegistryProvider>);
    expect(html).toMatch(/<button class="button primary danger" disabled="" type="submit"><mark>Remove<\/mark><\/button>/);
  });

  it("overrides fields, inputs and controls independently", () => {
    const execute = vi.fn();
    const markup = renderToStaticMarkup(
      <AtlasRendererRegistryProvider registries={{
        fields: {
          title: ({ value }) => <mark>Field: {String(value)}</mark>,
        },
        inputs: {
          text: ({ definition }) => (
            <input data-custom-input="true" name={definition.id} />
          ),
        },
        operationControls: {
          destructive: ({ label }) => <span>Control: {label}</span>,
        },
      }}>
        <Fragment>
          <FieldValue field={titleField} value="Example" />
          <OperationInput definition={titleInput} field={titleField} />
          <OperationControl
            label="Delete"
            onExecute={execute}
            operation={deleteOperation}
            pending={false}
          />
        </Fragment>
      </AtlasRendererRegistryProvider>,
    );

    expect(markup).toContain("<mark>Field: Example</mark>");
    expect(markup).toContain('data-custom-input="true"');
    expect(markup).toContain(
      '<button class="action-menu-item" type="button"><span>Control: Delete</span></button>',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains standard renderers when no application override exists", () => {
    const markup = renderToStaticMarkup(createElement(Fragment, {},
      createElement(FieldValue, { field: titleField, value: "Example" }),
      createElement(OperationInput, { definition: titleInput }),
    ));

    expect(markup).toContain("Example");
    expect(markup).toContain('name="title"');
  });
});
