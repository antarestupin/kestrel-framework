import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AtlasFieldManifest,
  AtlasOperationInputManifest,
  AtlasOperationManifest,
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
