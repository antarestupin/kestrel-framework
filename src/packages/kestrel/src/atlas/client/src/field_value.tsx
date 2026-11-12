import { resolveTextMaxLength } from "../../text_presentation.js";
import { DisplayText } from "./display_text.js";

import type { AtlasFieldRendererProperties } from "./renderer_registry.js";
import { resolveAtlasRenderer, useAtlasRendererRegistries } from "./renderer_registry.js";
import { getAtlasBasePath } from "./runtime.js";
import { Icon } from "./ui/icon.js";

/** Resolves one Resource value through the application registry. */
export function FieldValue(properties: AtlasFieldRendererProperties) {
  const { field, resource } = properties;
  const { fields } = useAtlasRendererRegistries();
  const Renderer = resolveAtlasRenderer(fields, [
    resource === undefined ? undefined : `${resource.id}.${field.id}`,
    field.id,
    field.kind,
    "default",
  ]) ?? StandardFieldValue;

  return <Renderer {...properties} />;
}

/** Standard field renderer retained as the fallback for every field kind. */
function StandardFieldValue({
  basePath,
  context,
  textMaxLength,
  resource,
  field,
  onOpenRelation,
  relationReferences = [],
  value,
}: AtlasFieldRendererProperties) {
  // Keep source values intact and shorten only standard list presentation.
  const limit = resolveTextMaxLength(resource, textMaxLength);
  const renderText = (text: string) => (
    <DisplayText text={text} maxLength={context === "list" ? limit : false} />
  );

  if (value === null || value === undefined || value === "") {
    return <span className="empty-value">—</span>;
  }

  if (field.kind === "boolean") {
    return <span className={`boolean-value ${value ? "true" : "false"}`}>
      <Icon name={value ? "success" : "cancel"} />
      {value ? "Yes" : "No"}
    </span>;
  }

  if (field.kind === "date" || field.kind === "datetime") {
    const date = new Date(String(value));

    return Number.isNaN(date.valueOf())
      ? String(value)
      : date.toLocaleString();
  }

  if (field.kind === "relation" && relationReferences.length > 0) {
    return (
      <span className="relation-values">
        {relationReferences.map((reference, index) => {
          const label = String(reference.label);
          const recordId = reference.recordId;

          if (recordId === undefined || basePath === undefined) {
            return <span key={`${label}-${index}`}>{renderText(label)}</span>;
          }

          const href = `${getAtlasBasePath(basePath)}/${reference.resourceId}/${
            encodeURIComponent(recordId)
          }`;

          return (
            <a
              href={href}
              key={`${reference.resourceId}-${recordId}-${index}`}
              onClick={(event) => {
                // Modified clicks retain browser link behavior, such as opening a new tab.
                if (onOpenRelation === undefined || event.button !== 0
                  || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpenRelation(reference.resourceId, recordId);
              }}
            >
              {renderText(label)}
            </a>
          );
        })}
      </span>
    );
  }

  if (field.kind === "relation" && Array.isArray(value)) {
    return value.map((item, index) => <span key={index}>{index > 0 ? ", " : ""}{renderText(String(item))}</span>);
  }

  if ((field.kind === "text" || field.kind === "email" || field.kind === "relation") && typeof value === "string") {
    return renderText(value);
  }

  return typeof value === "object"
    ? <code>{JSON.stringify(value)}</code>
    : String(value);
}

