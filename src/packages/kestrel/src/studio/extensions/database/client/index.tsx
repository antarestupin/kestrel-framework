import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";

import { StudioPageHeader } from "../../../client/src/page.js";
import type { StudioPageRenderer } from "../../../client/src/page_renderer.js";
import { addStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import type { StudioPageManifest } from "../../../extension.js";
import { Icon } from "../../../client/src/ui/icon.js";
import {
  DATABASE_SCHEMA_PAGE_KIND,
  type StudioDatabaseColumn,
  type StudioDatabaseLayout,
  type StudioDatabaseSchema,
  type StudioDatabaseTable,
} from "../contract.js";
import "./styles.css";

/** Client renderer contributed by the native Database extension. */
const databaseSchemaPageRenderer: StudioPageRenderer = {
  kind: DATABASE_SCHEMA_PAGE_KIND,
  render: (page) => <DatabaseSchemaPage page={page} />,
};

addStudioPageRenderer(databaseSchemaPageRenderer);

function DatabaseSchemaPage({ page }: { page: StudioPageManifest }) {
  return (
    <div className="page database-schema-page">
      <StudioPageHeader page={page} eyebrow="Database" />
      {page.dataPath === undefined
        ? <p className="error-panel">The database page has no data endpoint.</p>
        : <DatabaseLayoutData dataPath={page.dataPath} />}
    </div>
  );
}

function DatabaseLayoutData({ dataPath }: { dataPath: string }) {
  const resource = useDatabaseLayout(dataPath);

  if (resource.status === "loading") {
    return <p className="loading-panel">Loading database schema…</p>;
  }

  if (resource.status === "error") {
    return <p className="error-panel">{resource.message}</p>;
  }

  if (resource.layout.schemas.length === 0) {
    return (
      <section className="empty-state">
        <span aria-hidden="true">{"{}"}</span>
        <h2>No application tables found</h2>
        <p>Studio excludes PostgreSQL system schemas from this view.</p>
      </section>
    );
  }

  return <DatabaseLayout layout={resource.layout} />;
}

/** Renders the loaded database layout with page-wide comment controls. */
export function DatabaseLayout({ layout }: { layout: StudioDatabaseLayout }) {
  const tableCount = layout.schemas.reduce(
    (count, schema) => count + schema.tables.length,
    0,
  );
  const commentKeys = getDatabaseCommentKeys(layout);
  const [expandedComments, setExpandedComments] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const allCommentsExpanded = commentKeys.length > 0
    && commentKeys.every((key) => expandedComments.has(key));
  const expansion: DatabaseCommentExpansion = {
    expandedComments,
    toggle: (key) => {
      setExpandedComments((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
  };

  const toggleAllComments = () => {
    setExpandedComments(
      allCommentsExpanded ? new Set() : new Set(commentKeys),
    );
  };

  return (
    <DatabaseCommentExpansionContext.Provider value={expansion}>
      <div className="database-layout">
        <div className="database-layout-toolbar">
          <p className="database-layout-summary">
            {tableCount} {tableCount === 1 ? "table" : "tables"} across{" "}
            {layout.schemas.length}{" "}
            {layout.schemas.length === 1 ? "schema" : "schemas"}
          </p>
          {commentKeys.length === 0
            ? null
            : (
                <button
                  aria-pressed={allCommentsExpanded}
                  className="database-comments-toggle"
                  onClick={toggleAllComments}
                  type="button"
                >
                  {allCommentsExpanded
                    ? "Collapse all comments"
                    : "Expand all comments"}
                </button>
              )}
        </div>
        {layout.schemas.map((schema) => (
          <DatabaseSchemaSection key={schema.name} schema={schema} />
        ))}
      </div>
    </DatabaseCommentExpansionContext.Provider>
  );
}

interface DatabaseCommentExpansion {
  readonly expandedComments: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
}

const DatabaseCommentExpansionContext = createContext<
  DatabaseCommentExpansion | undefined
>(undefined);

/** Collects stable disclosure keys without requiring child registration. */
function getDatabaseCommentKeys(layout: StudioDatabaseLayout): string[] {
  return layout.schemas.flatMap((schema) => [
    ...(schema.description === undefined ? [] : [`schema ${schema.name}`]),
    ...schema.tables.flatMap((table) => {
      const tableName = `${schema.name}.${table.name}`;
      return [
        ...(table.description === undefined ? [] : [`table ${tableName}`]),
        ...table.columns.flatMap((column) =>
          column.description === undefined
            ? []
            : [`column ${tableName}.${column.name}`]
        ),
      ];
    }),
  ]);
}

/** Renders one independently expandable PostgreSQL schema section. */
export function DatabaseSchemaSection({
  schema,
}: {
  schema: StudioDatabaseSchema;
}) {
  const comment = useDatabaseComment(`schema ${schema.name}`);

  return (
    <section className="database-schema">
      <header className="database-schema-heading">
        <div className="database-schema-title">
          <h2>{schema.name}</h2>
          {schema.description === undefined
            ? null
            : <DatabaseCommentButton disclosure={comment} />}
        </div>
        <span>
          {schema.tables.length}{" "}
          {schema.tables.length === 1 ? "table" : "tables"}
        </span>
      </header>
      {schema.description === undefined
        ? null
        : (
            <p
              className="database-schema-description"
              hidden={!comment.expanded}
              id={comment.commentId}
            >
              {schema.description}
            </p>
          )}
      <div className="database-table-grid">
        {schema.tables.map((table) => (
          <DatabaseTableCard
            key={`${schema.name}.${table.name}`}
            schemaName={schema.name}
            table={table}
          />
        ))}
      </div>
    </section>
  );
}

function DatabaseTableCard({
  schemaName,
  table,
}: {
  schemaName: string;
  table: StudioDatabaseTable;
}) {
  const comment = useDatabaseComment(`table ${schemaName}.${table.name}`);

  return (
    <article className="database-table-card">
      <header>
        <h3>{table.name}</h3>
        <div className="database-table-controls">
          {table.kind === "partitioned-table"
            ? <span className="database-table-kind">Partitioned</span>
            : null}
          {table.description === undefined
            ? null
            : <DatabaseCommentButton disclosure={comment} />}
        </div>
      </header>
      {table.description === undefined
        ? null
        : (
            <p
              className="database-table-description"
              hidden={!comment.expanded}
              id={comment.commentId}
            >
              {table.description}
            </p>
          )}
      {table.columns.length === 0
        ? <p className="database-table-empty">No columns</p>
        : (
            <div className="database-column-list">
              {table.columns.map((column) => (
                <DatabaseColumnRow
                  column={column}
                  key={column.name}
                  tableName={`${schemaName}.${table.name}`}
                />
              ))}
            </div>
          )}
    </article>
  );
}

function DatabaseColumnRow({
  column,
  tableName,
}: {
  column: StudioDatabaseColumn;
  tableName: string;
}) {
  const comment = useDatabaseComment(`column ${tableName}.${column.name}`);

  return (
    <div className="database-column">
      <div className="database-column-summary">
        <div className="database-column-name">
          {column.primaryKey
            ? <abbr title="Primary key"><Icon name="key" /></abbr>
            : <span className="database-column-marker" />}
          <code>{column.name}</code>
          {column.nullable
            ? <span className="database-nullable" title="Nullable">?</span>
            : null}
        </div>
        <code className="database-column-type">{column.type}</code>
        <div className="database-column-comment">
          {column.description === undefined
            ? null
            : <DatabaseCommentButton disclosure={comment} />}
        </div>
      </div>
      {column.description === undefined
        ? null
        : (
            <p
              className="database-column-description"
              hidden={!comment.expanded}
              id={comment.commentId}
            >
              {column.description}
            </p>
          )}
    </div>
  );
}

interface DatabaseCommentDisclosure {
  readonly commentId: string;
  readonly expanded: boolean;
  readonly label: string;
  readonly toggle: () => void;
}

/** Provides independent disclosure state and accessible relationships. */
function useDatabaseComment(label: string): DatabaseCommentDisclosure {
  const commentId = useId();
  const expansion = useContext(DatabaseCommentExpansionContext);
  const [locallyExpanded, setLocallyExpanded] = useState(false);
  const expanded = expansion?.expandedComments.has(label) ?? locallyExpanded;

  return {
    commentId,
    expanded,
    label,
    toggle: expansion === undefined
      ? () => setLocallyExpanded((current) => !current)
      : () => expansion.toggle(label),
  };
}

function DatabaseCommentButton({
  disclosure,
}: {
  disclosure: DatabaseCommentDisclosure;
}) {
  const action = disclosure.expanded ? "Hide" : "Show";
  const label = `${action} comment for ${disclosure.label}`;

  return (
    <button
      aria-controls={disclosure.commentId}
      aria-expanded={disclosure.expanded}
      aria-label={label}
      className="database-comment-button"
      onClick={disclosure.toggle}
      title={label}
      type="button"
    >
      <Icon
        className="database-comment-chevron"
        name={disclosure.expanded
          ? "disclosure-expanded"
          : "disclosure-collapsed"}
      />
    </button>
  );
}

type DatabaseLayoutResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; layout: StudioDatabaseLayout };

function useDatabaseLayout(dataPath: string): DatabaseLayoutResource {
  const [resource, setResource] = useState<DatabaseLayoutResource>({
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();

    void fetch(dataPath, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Database schema request failed with status ${response.status}.`,
          );
        }

        return response.json() as Promise<StudioDatabaseLayout>;
      })
      .then((layout) => setResource({ status: "ready", layout }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setResource({
          status: "error",
          message: error instanceof Error
            ? error.message
            : "Unable to load the database schema.",
        });
      });

    return () => controller.abort();
  }, [dataPath]);

  return resource;
}
