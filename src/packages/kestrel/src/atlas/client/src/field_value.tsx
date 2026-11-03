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
  field,
  onOpenRelation,
  relationReferences = [],
  value,
}: AtlasFieldRendererProperties) {
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
            return <span key={`${label}-${index}`}>{label}</span>;
          }

          const href = `${getAtlasBasePath(basePath)}/${reference.resourceId}/${
            encodeURIComponent(recordId)
          }`;

          return (
            <a
              href={href}
              key={`${reference.resourceId}-${recordId}-${index}`}
              onClick={(event) => {
                if (onOpenRelation !== undefined) {
                  event.preventDefault();
                  onOpenRelation(reference.resourceId, recordId);
                }
              }}
            >
              {label}
            </a>
          );
        })}
      </span>
    );
  }

  if (field.kind === "relation" && Array.isArray(value)) {
    return value.map(String).join(", ");
  }

  return typeof value === "object"
    ? <code>{JSON.stringify(value)}</code>
    : String(value);
}

