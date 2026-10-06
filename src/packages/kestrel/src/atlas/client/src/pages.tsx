import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  AtlasCollectionFilter,
  AtlasCollectionQuery,
  AtlasCollectionSort,
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationInputManifest,
  AtlasOperationResponse,
  AtlasRecordActionManifest,
  AtlasRelatedCollectionManifest,
  AtlasRelatedRecordsFeaturesManifest,
  AtlasResourceManifest,
  AtlasResourceViewManifest,
} from "../../contract.js";
import { CatalogIcon, Icon } from "./ui/icon.js";
import { Dialog, Menu } from "./ui/primitives.js";
import {
  executeAtlasRecordAction,
  executeAtlasOperation,
  getAtlasRedirectPath,
  getAtlasBasePath,
  getRecordActionParameters,
  getRecordActionRoute,
  getResourceListFields,
  getResourceRecordLabel,
  isRecord,
  isRecordActionShownInList,
  readListResult,
} from "./runtime.js";
import {
  useRelationHydration,
} from "./relations.js";
import {
  useAtlasActionFeedback,
} from "./effects.js";
import { RelationInput } from "./relation_input.js";
import { useAtlasConfirmation } from "./confirmation.js";
import {
  parseAtlasCollectionSearch,
  serializeAtlasCollectionSearch,
} from "./collection.js";
import {
  type AtlasFieldRendererProperties,
  type AtlasInputRendererProperties,
  type AtlasOperationControlRendererProperties,
  resolveAtlasRenderer,
  useAtlasRendererRegistries,
} from "./renderer_registry.js";

export interface ResourceProperties {
  manifest: AtlasManifest;
  resource: AtlasResourceManifest;
}

export interface RecordProperties extends ResourceProperties {
  recordId: string;
}

export interface ResourceViewProperties extends ResourceProperties {
  view: AtlasResourceViewManifest;
}

export interface RecordActionProperties extends RecordProperties {
  action: AtlasRecordActionManifest;
}

export function ResourceListPage({
  manifest,
  resource,
}: ResourceProperties) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const collectionQuery = parseAtlasCollectionSearch(search);

  return (
    <ResourceList
      collectionQuery={collectionQuery}
      manifest={manifest}
      onCreate={() => void navigate({ to: `/${resource.id}/create` })}
      onOpenAction={(recordId, action) => void navigate({
        to: getRecordActionRoute(resource, recordId, action),
      })}
      onOpenRelation={(resourceId, recordId) => void navigate({
        to: `/${resourceId}/${encodeURIComponent(recordId)}`,
      })}
      onEdit={(recordId) => void navigate({
        to: `/${resource.id}/${encodeURIComponent(recordId)}/edit`,
      })}
      onRead={(recordId) => void navigate({
        to: `/${resource.id}/${encodeURIComponent(recordId)}`,
      })}
      onQueryChange={(query) => void navigate({
        to: `/${resource.id}`,
        search: serializeAtlasCollectionSearch(query) as never,
      })}
      resource={resource}
    />
  );
}

/** Reusable Resource list content independent from the active router. */
export function ResourceList({
  collectionQuery,
  manifest,
  onCreate,
  onEdit,
  onOpenAction,
  onOpenRelation,
  onRead,
  onQueryChange,
  resource,
}: ResourceProperties & {
  collectionQuery: AtlasCollectionQuery;
  onCreate: () => void;
  onEdit: (recordId: string) => void;
  onOpenAction: (
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  onRead: (recordId: string) => void;
  onQueryChange: (query: AtlasCollectionQuery) => void;
}) {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Resource"
        title={resource.label}
        actions={(
          <button className="button primary" onClick={onCreate} type="button">
            <Icon name="create" />
            Create {resource.labelSingular.toLocaleLowerCase()}
          </button>
        )}
      />

      <ResourceCollection
        collectionQuery={collectionQuery}
        features={defaultCollectionFeatures}
        manifest={manifest}
        onEdit={onEdit}
        onOpenAction={onOpenAction}
        onOpenRelation={onOpenRelation}
        onQueryChange={onQueryChange}
        onRead={onRead}
        resource={resource}
      />
    </div>
  );
}

const defaultCollectionFeatures: AtlasRelatedRecordsFeaturesManifest = {
  search: true,
  filters: true,
  sorting: true,
  pagination: true,
  recordActions: true,
};

export interface ResourceCollectionScope {
  /** Filters supplied by the parent context and never exposed as controls. */
  readonly filters?: readonly AtlasCollectionFilter[];
  /** Optional operation replacing the Resource's conventional list. */
  readonly operation?: AtlasResourceManifest["capabilities"]["list"];
  /** Fixed inputs supplied to a custom contextual operation. */
  readonly input?: Readonly<Record<string, unknown>>;
}

/** Collection engine shared by full Resource pages and embedded relations. */
export function ResourceCollection({
  collectionQuery,
  controlsVisible = true,
  features,
  manifest,
  onEdit,
  onOpenAction,
  onOpenRelation,
  onQueryChange,
  onRead,
  resource,
  scope = {},
}: ResourceProperties & {
  collectionQuery: AtlasCollectionQuery;
  controlsVisible?: boolean;
  features: AtlasRelatedRecordsFeaturesManifest;
  onEdit: (recordId: string) => void;
  onOpenAction: (
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  onQueryChange: (query: AtlasCollectionQuery) => void;
  onRead: (recordId: string) => void;
  scope?: ResourceCollectionScope;
}) {
  const effectiveQuery = createScopedCollectionQuery(
    collectionQuery,
    scope.filters ?? [],
  );
  const operation = scope.operation ?? resource.capabilities.list;
  const query = useQuery({
    queryKey: [resource.id, "collection", operation.id, scope, collectionQuery],
    queryFn: async () => readListResult(
      await executeAtlasOperation(
        manifest.basePath,
        operation,
        { ...effectiveQuery, ...scope.input },
      ),
    ),
  });

  return (
    <div className="resource-collection">
      {controlsVisible && (features.search || features.filters) ? (
        <CollectionControls
          filtersEnabled={features.filters}
          onChange={onQueryChange}
          query={collectionQuery}
          resource={resource}
          searchEnabled={features.search}
        />
      ) : null}
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} /> : null}
      {query.data === undefined ? null : (
        <ResourceTable
          fields={getResourceListFields(resource)}
          items={query.data.items}
          manifest={manifest}
          onEdit={onEdit}
          onOpenAction={onOpenAction}
          onOpenRelation={onOpenRelation}
          onRead={onRead}
          {...(features.sorting
            ? {
              onSortingChange: (sorting: readonly AtlasCollectionSort[]) => onQueryChange({
                ...collectionQuery,
                pagination: { ...collectionQuery.pagination, page: 1 },
                sorting: sorting.length === 0 ? undefined : sorting,
              }),
            }
            : {})}
          recordActionsEnabled={features.recordActions}
          resource={resource}
          sorting={collectionQuery.sorting ?? []}
        />
      )}
      {features.pagination ? (
        <ResourcePagination
          hasNextPage={query.data?.hasNextPage === true}
          onPageChange={(page) => onQueryChange({
            ...collectionQuery,
            pagination: { ...collectionQuery.pagination, page },
          })}
          page={collectionQuery.pagination.page}
        />
      ) : null}
    </div>
  );
}

/** Applies immutable parent filters without exposing them as user controls. */
export function createScopedCollectionQuery(
  query: AtlasCollectionQuery,
  scopeFilters: readonly AtlasCollectionFilter[],
): AtlasCollectionQuery {
  if (scopeFilters.length === 0) {
    return query;
  }

  return {
    ...query,
    filters: [...scopeFilters, ...query.filters ?? []],
  };
}

/** Standard list renderer used by Query-backed Resource Views. */
export function ResourceListViewPage({
  manifest,
  resource,
  view,
}: ResourceViewProperties) {
  const navigate = useNavigate();

  return (
    <ResourceListView
      manifest={manifest}
      onOpenAction={(recordId, action) => void navigate({
        to: getRecordActionRoute(resource, recordId, action),
      })}
      onOpenRelation={(resourceId, recordId) => void navigate({
        to: `/${resourceId}/${encodeURIComponent(recordId)}`,
      })}
      onEdit={(recordId) => void navigate({
        to: `/${resource.id}/${encodeURIComponent(recordId)}/edit`,
      })}
      onRead={(recordId) => void navigate({
        to: `/${resource.id}/${encodeURIComponent(recordId)}`,
      })}
      resource={resource}
      view={view}
    />
  );
}

/** Reusable View list content with navigation supplied by its host. */
export function ResourceListView({
  manifest,
  onEdit,
  onOpenAction,
  onOpenRelation,
  onRead,
  resource,
  view,
}: ResourceViewProperties & {
  onEdit: (recordId: string) => void;
  onOpenAction: (
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  onRead: (recordId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const query = useQuery({
    queryKey: [resource.id, "view", view.id, page, pageSize],
    queryFn: async () => readListResult(
      await executeAtlasOperation(
        manifest.basePath,
        view.query,
        { pagination: { type: "page", page, pageSize } },
      ),
    ),
  });

  return (
    <div className="page">
      <PageHeader eyebrow={resource.label} title={view.label} />
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} /> : null}
      {query.data === undefined ? null : (
        <ResourceTable
          fields={getResourceListFields(resource)}
          items={query.data.items}
          manifest={manifest}
          onEdit={onEdit}
          onOpenAction={onOpenAction}
          onOpenRelation={onOpenRelation}
          onRead={onRead}
          resource={resource}
        />
      )}
      <ResourcePagination
        hasNextPage={query.data?.hasNextPage === true}
        onPageChange={setPage}
        page={page}
      />
    </div>
  );
}

export function ResourceReadPage({
  manifest,
  resource,
  recordId,
}: RecordProperties) {
  const navigate = useNavigate();

  return (
    <ResourceRead
      manifest={manifest}
      onDeleted={() => void navigate({ to: `/${resource.id}` })}
      onEdit={() => void navigate({
        to: `/${resource.id}/${encodeURIComponent(recordId)}/edit`,
      })}
      onOpenAction={(action) => void navigate({
        to: getRecordActionRoute(resource, recordId, action),
      })}
      onEditRelated={(relatedResource, relatedRecordId) => void navigate({
        to: `/${relatedResource.id}/${encodeURIComponent(relatedRecordId)}/edit`,
      })}
      onOpenRelatedAction={(relatedResource, relatedRecordId, action) => void navigate({
        to: getRecordActionRoute(relatedResource, relatedRecordId, action),
      })}
      onOpenRelation={(resourceId, relatedRecordId) => void navigate({
        to: `/${resourceId}/${encodeURIComponent(relatedRecordId)}`,
      })}
      recordId={recordId}
      resource={resource}
    />
  );
}

/** Reusable record content that reports navigation outcomes to its host. */
export function ResourceRead({
  manifest,
  onDeleted,
  onEdit,
  onOpenAction,
  onEditRelated,
  onOpenRelatedAction,
  onOpenRelation,
  resource,
  recordId,
}: RecordProperties & {
  onDeleted: () => void;
  onEdit: () => void;
  onOpenAction: (action: AtlasRecordActionManifest) => void;
  onEditRelated: (
    resource: AtlasResourceManifest,
    recordId: string,
  ) => void;
  onOpenRelatedAction: (
    resource: AtlasResourceManifest,
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
}) {
  const confirm = useAtlasConfirmation();
  const queryClient = useQueryClient();
  const query = useResourceRecord(manifest.basePath, resource, recordId);
  const relations = useRelationHydration(
    manifest,
    resource,
    query.data === undefined ? [] : [query.data],
  );
  const remove = useMutation({
    mutationFn: () => executeAtlasOperation(
      manifest.basePath,
      resource.capabilities.delete,
      { [resource.identity]: recordId },
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [resource.id] });
      onDeleted();
    },
  });

  const deleteRecord = async () => {
    if (await confirm({
      confirmLabel: "Delete",
      description: `Delete this ${resource.labelSingular.toLocaleLowerCase()}? This cannot be undone.`,
      title: `Delete ${resource.labelSingular.toLocaleLowerCase()}?`,
      tone: "danger",
    })) {
      remove.mutate();
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={resource.labelSingular}
        title={getResourceRecordLabel(resource, query.data, recordId)}
        actions={(
          <>
            <button className="button" onClick={onEdit} type="button">
              <Icon name="edit" />
              Edit
            </button>
            <RecordActionsMenu
              actions={resource.recordActions}
              deletePending={remove.isPending}
              manifest={manifest}
              onDelete={deleteRecord}
              onOpenAction={onOpenAction}
              recordId={recordId}
              resource={resource}
            />
          </>
        )}
      />
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} /> : null}
      {remove.isError ? <ErrorState error={remove.error} /> : null}
      {relations.error === undefined
        ? null
        : <ErrorState error={relations.error} />}
      {query.data === undefined ? null : (
        <>
          <dl className="detail-panel">
            {resource.fields.filter((field) => !field.hidden).map((field) => (
              <div key={field.id}>
                <dt>{field.label}</dt>
                <dd>
                  <FieldValue
                    basePath={manifest.basePath}
                    field={field}
                    onOpenRelation={onOpenRelation}
                    relationReferences={relations.references(
                      field,
                      query.data[field.id],
                    )}
                    resource={resource}
                    value={relations.resolve(field, query.data[field.id])}
                  />
                </dd>
              </div>
            ))}
          </dl>
          {(resource.relatedCollections ?? []).map((collection) => (
            <RelatedResourceCollection
              collection={collection}
              key={collection.id}
              manifest={manifest}
              onEdit={onEditRelated}
              onOpenAction={onOpenRelatedAction}
              onOpenRelation={onOpenRelation}
              parentRecordId={recordId}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** Embedded list constrained to one inverse relation of the parent record. */
function RelatedResourceCollection({
  collection,
  manifest,
  onEdit,
  onOpenAction,
  onOpenRelation,
  parentRecordId,
}: {
  collection: AtlasRelatedCollectionManifest;
  manifest: AtlasManifest;
  onEdit: (resource: AtlasResourceManifest, recordId: string) => void;
  onOpenAction: (
    resource: AtlasResourceManifest,
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  parentRecordId: string;
}) {
  const relatedResource = manifest.resources.find(
    (candidate) => candidate.id === collection.resource,
  );
  const [collectionQuery, setCollectionQuery] = useState<AtlasCollectionQuery>({
    pagination: {
      type: "page",
      page: 1,
      pageSize: collection.pageSize,
    },
  });
  const [controlsVisible, setControlsVisible] = useState(false);

  useEffect(() => {
    // A retained route component must not carry pagination into another parent.
    setCollectionQuery({
      pagination: {
        type: "page",
        page: 1,
        pageSize: collection.pageSize,
      },
    });
    setControlsVisible(false);
  }, [collection.id, collection.pageSize, parentRecordId]);

  if (relatedResource === undefined) {
    return null;
  }

  const scope: ResourceCollectionScope = collection.query === undefined
    ? {
      filters: [{
        field: collection.field,
        operator: "equals",
        value: parentRecordId,
      }],
    }
    : {
      operation: collection.query,
      ...(collection.recordInput === undefined
        ? {}
        : { input: { [collection.recordInput]: parentRecordId } }),
    };
  const filtersAvailable = collection.features.filters
    && relatedResource.fields.some(
      (field) => field.filterOperators.length > 0,
    );
  const searchAvailable = collection.features.search
    && relatedResource.fields.some((field) => field.searchable);
  const controlsAvailable = filtersAvailable || searchAvailable;
  const activeControlCount = (collectionQuery.filters?.length ?? 0)
    + (collectionQuery.search === undefined ? 0 : 1);

  return (
    <section className="related-resource-section">
      <header className="related-resource-heading">
        <h2>{collection.label}</h2>
        {controlsAvailable ? (
          <button
            aria-expanded={controlsVisible}
            className="button related-resource-controls-toggle"
            onClick={() => setControlsVisible((visible) => !visible)}
            type="button"
          >
            Search and filters{
              activeControlCount === 0 ? "" : ` (${activeControlCount})`
            }
          </button>
        ) : null}
      </header>
      <ResourceCollection
        collectionQuery={collectionQuery}
        controlsVisible={controlsVisible}
        features={collection.features}
        manifest={manifest}
        onEdit={(recordId) => onEdit(relatedResource, recordId)}
        onOpenAction={(recordId, action) => onOpenAction(
          relatedResource,
          recordId,
          action,
        )}
        onOpenRelation={onOpenRelation}
        onQueryChange={setCollectionQuery}
        onRead={(recordId) => onOpenRelation(relatedResource.id, recordId)}
        resource={relatedResource}
        scope={scope}
      />
    </section>
  );
}

export function ResourceCreatePage(properties: ResourceProperties) {
  const { resource } = properties;
  const navigate = useNavigate();

  return (
    <ResourceForm
      {...properties}
      mode="create"
      onCancel={() => void navigate({ to: `/${resource.id}` })}
      onSuccess={(record) => {
        const identity = record[resource.identity];

        void navigate({
          to: identity === undefined
            ? `/${resource.id}`
            : `/${resource.id}/${encodeURIComponent(String(identity))}`,
        });
      }}
    />
  );
}

export function ResourceEditPage(properties: RecordProperties) {
  const { recordId, resource } = properties;
  const navigate = useNavigate();
  const recordRoute = `/${resource.id}/${encodeURIComponent(recordId)}`;

  return (
    <ResourceForm
      {...properties}
      mode="update"
      onCancel={() => void navigate({ to: recordRoute })}
      onSuccess={() => void navigate({ to: recordRoute })}
    />
  );
}

/** Reusable create and update form with explicit lifecycle callbacks. */
export function ResourceForm({
  manifest,
  onCancel,
  onSuccess,
  resource,
  recordId,
  mode,
}: ResourceProperties & {
  mode: "create" | "update";
  onCancel: () => void;
  onSuccess: (record: Record<string, unknown>) => void;
  recordId?: string;
}) {
  const operation = mode === "create"
    ? resource.capabilities.create
    : resource.capabilities.update;
  const recordQuery = useResourceRecord(
    manifest.basePath,
    resource,
    recordId ?? "",
    mode === "update",
  );
  const mutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      executeAtlasOperation<Record<string, unknown>>(
        manifest.basePath,
        operation,
        input,
      ),
    onSuccess,
  });
  const bodyInputs = operation.inputs.filter(
    (input) => input.id !== resource.identity,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = Object.fromEntries(bodyInputs.flatMap((definition) => {
      const value = readFormValue(form, definition);

      return value === undefined ? [] : [[definition.id, value]];
    }));

    if (recordId !== undefined) {
      input[resource.identity] = recordId;
    }

    mutation.mutate(input);
  };

  if (mode === "update" && recordQuery.isPending) {
    return <div className="page"><LoadingState /></div>;
  }

  if (recordQuery.isError) {
    return <div className="page"><ErrorState error={recordQuery.error} /></div>;
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={resource.labelSingular}
        title={mode === "create" ? `Create ${resource.labelSingular}` : "Edit record"}
      />
      <form className="form-panel" onSubmit={submit}>
        {bodyInputs.map((input) => (
          <OperationInput
            definition={input}
            field={resource.fields.find((field) => field.id === input.id)}
            key={input.id}
            manifest={manifest}
            resource={resource}
            value={recordQuery.data?.[input.id]}
          />
        ))}
        {mutation.isError ? <ErrorState error={mutation.error} /> : null}
        <div className="form-actions">
          <OperationControl
            icon="save"
            label={mutation.isPending ? "Saving…" : "Save"}
            operation={operation}
            pending={mutation.isPending}
            presentation="primary"
            type="submit"
          />
          <button className="button" onClick={onCancel} type="button">
            <Icon name="cancel" />
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** Resolves explicit Action metadata before same-named Resource inheritance. */
export function getRecordActionParameterField(
  action: AtlasRecordActionManifest,
  resource: AtlasResourceManifest,
  parameterId: string,
): AtlasFieldManifest | undefined {
  return action.parameterFields?.find((field) => field.id === parameterId)
    ?? resource.fields.find((field) => field.id === parameterId);
}

/** Canonical route adapter for a record Action. */
export function RecordActionPage({
  action,
  manifest,
  recordId,
  resource,
}: RecordActionProperties) {
  const navigate = useNavigate();
  const recordRoute = `/${resource.id}/${encodeURIComponent(recordId)}`;

  return (
    <div className="page">
      <PageHeader eyebrow={resource.labelSingular} title={action.label} />
      <RecordActionForm
        action={action}
        manifest={manifest}
        onCancel={() => void navigate({ to: recordRoute })}
        onSuccess={(response) => void navigate({
          to: getAtlasRedirectPath(manifest, response.effects)
            ?? recordRoute,
        })}
        recordId={recordId}
        resource={resource}
      />
    </div>
  );
}

/** Schema-derived Action form shared by canonical pages and dialogs. */
export function RecordActionForm({
  action,
  manifest,
  onCancel,
  onEmptyChange,
  onSuccess,
  recordId,
  resource,
}: RecordActionProperties & {
  onCancel: () => void;
  onEmptyChange?: (empty: boolean) => void;
  onSuccess: (response: AtlasOperationResponse) => void;
}) {
  const confirm = useAtlasConfirmation();
  const queryClient = useQueryClient();
  const trackAction = useAtlasActionFeedback();
  const parameters = getRecordActionParameters(action);
  const mutation = useMutation({
    mutationFn: (input: Record<string, unknown>) => trackAction(
      executeAtlasRecordAction(
        manifest.basePath,
        resource,
        action,
        input,
      ),
      {
        label: action.label,
        ...(action.feedback === undefined
          ? {}
          : { feedback: action.feedback }),
      },
    ),
    onSuccess: async (response) => {
      // Let dialog hosts close immediately once the Action has succeeded.
      onSuccess(response);
      // Every record Action can affect the record, main list and Resource Views.
      await queryClient.invalidateQueries({ queryKey: [resource.id] });
    },
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const input: Record<string, unknown> = {
      [action.recordInput]: recordId,
    };

    for (const definition of parameters) {
      const value = readFormValue(form, definition);

      if (value !== undefined) {
        input[definition.id] = value;
      }
    }

    if (action.confirmation !== undefined && !await confirm({
      confirmLabel: action.label,
      description: action.confirmation,
      title: `${action.label}?`,
      tone: action.action.effect === "destructive" ? "danger" : "default",
    })) {
      return;
    }

    mutation.mutate(input);
  };

  return (
    <form
      className="form-panel"
      onChange={(event) => onEmptyChange?.(
        !hasAtlasFormContent(
          parameters.map((definition) =>
            readFormValue(new FormData(event.currentTarget), definition)),
        ),
      )}
      onSubmit={submit}
    >
      {parameters.map((parameter) => (
        <OperationInput
          definition={parameter}
          field={getRecordActionParameterField(
            action,
            resource,
            parameter.id,
          )}
          key={parameter.id}
          manifest={manifest}
          resource={resource}
        />
      ))}
      {parameters.length === 0 ? (
        <p className="form-description">
          Run this Action for {resource.labelSingular.toLocaleLowerCase()} {recordId}.
        </p>
      ) : null}
      {mutation.isError ? <ErrorState error={mutation.error} /> : null}
      <div className="form-actions">
        <OperationControl
          icon="play"
          label={mutation.isPending ? "Running…" : action.label}
          operation={action.action}
          pending={mutation.isPending}
          presentation="primary"
          type="submit"
        />
        <button className="button" onClick={onCancel} type="button">
          <Icon name="cancel" />
          Cancel
        </button>
      </div>
    </form>
  );
}

/** In-context presentation of the same canonical record Action form. */
export function RecordActionDialog({
  action,
  manifest,
  onClose,
  recordId,
  resource,
}: RecordActionProperties & { onClose: () => void }) {
  const confirm = useAtlasConfirmation();
  const navigate = useNavigate();
  const [formEmpty, setFormEmpty] = useState(true);
  const [open, setOpen] = useState(false);
  const closeCompletionRef = useRef<(() => void) | undefined>(undefined);
  const dismissConfirmationPending = useRef(false);
  useEffect(() => {
    // Start closed so Base UI can apply its opening transition after mounting.
    setOpen(true);
  }, []);
  const closeDialog = useCallback((onComplete?: () => void) => {
    closeCompletionRef.current = onComplete;
    setOpen(false);
  }, []);
  const requestClose = useCallback(async () => {
    if (!open) {
      return;
    }

    if (formEmpty) {
      closeDialog();
      return;
    }

    if (dismissConfirmationPending.current) {
      return;
    }

    dismissConfirmationPending.current = true;

    const confirmed = await confirm({
      confirmLabel: "Discard",
      description: "The values entered in this form will be lost.",
      title: "Discard the entered values?",
      tone: "danger",
    });

    dismissConfirmationPending.current = false;

    if (confirmed) {
      closeDialog();
    }
  }, [closeDialog, confirm, formEmpty, open]);

  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) {
          requestClose();
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          const complete = closeCompletionRef.current;

          closeCompletionRef.current = undefined;
          onClose();
          complete?.();
        }
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="dialog-panel">
            <Dialog.Title className="visually-hidden">
              {action.label}
            </Dialog.Title>
            <Dialog.Close className="visually-hidden">
              Close dialog
            </Dialog.Close>
            <PageHeader
              actions={(
                <Link
                  className="button"
                  to={getRecordActionRoute(resource, recordId, action)}
                >
                  Permalink
                </Link>
              )}
              eyebrow={resource.labelSingular}
              title={action.label}
            />
            <RecordActionForm
              action={action}
              manifest={manifest}
              onCancel={requestClose}
              onEmptyChange={setFormEmpty}
              onSuccess={(response) => {
                const redirect = getAtlasRedirectPath(
                  manifest,
                  response.effects,
                );

                // Preserve the popup until its exit animation finishes.
                closeDialog(() => {
                  if (redirect !== undefined) {
                    void navigate({ to: redirect });
                  }
                });
              }}
              recordId={recordId}
              resource={resource}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useResourceRecord(
  basePath: string,
  resource: AtlasResourceManifest,
  recordId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: [resource.id, "read", recordId],
    enabled,
    queryFn: async () => {
      const result = await executeAtlasOperation(
        basePath,
        resource.capabilities.read,
        { [resource.identity]: recordId },
      );

      if (!isRecord(result)) {
        throw new TypeError("The resource read operation returned an invalid result.");
      }

      return result;
    },
  });
}

/** Search and flat-filter controls shared by conventional Resource lists. */
export function CollectionControls({
  filtersEnabled = true,
  onChange,
  query,
  resource,
  searchEnabled = true,
}: {
  filtersEnabled?: boolean;
  onChange: (query: AtlasCollectionQuery) => void;
  query: AtlasCollectionQuery;
  resource: AtlasResourceManifest;
  searchEnabled?: boolean;
}) {
  const searchable = searchEnabled
    && resource.fields.some((field) => field.searchable);
  const filterableFields = filtersEnabled
    ? resource.fields.filter((field) => field.filterOperators.length > 0)
    : [];
  const [search, setSearch] = useState(query.search ?? "");
  const [fieldId, setFieldId] = useState(filterableFields[0]?.id ?? "");
  const selectedField = filterableFields.find((field) => field.id === fieldId);
  const [operator, setOperator] = useState(
    selectedField?.filterOperators[0] ?? "equals",
  );
  const [value, setValue] = useState("");

  useEffect(() => setSearch(query.search ?? ""), [query.search]);
  useEffect(() => {
    if (selectedField !== undefined && !selectedField.filterOperators.includes(operator)) {
      setOperator(selectedField.filterOperators[0] ?? "equals");
    }
  }, [operator, selectedField]);

  if (!searchable && filterableFields.length === 0) {
    return null;
  }

  const resetPage = { ...query.pagination, page: 1 };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    onChange({
      ...query,
      pagination: resetPage,
      search: search.trim() === "" ? undefined : search.trim(),
    });
  };
  const addFilter = () => {
    if (selectedField === undefined) {
      return;
    }

    const filter = createCollectionFilter(
      selectedField,
      operator,
      value,
    );
    if (filter === undefined) {
      return;
    }

    onChange({
      ...query,
      pagination: resetPage,
      filters: [...query.filters ?? [], filter],
    });
    setValue("");
  };

  return (
    <div className="collection-controls">
      {searchable ? (
        <form className="collection-search" onSubmit={submitSearch}>
          <label>
            <span className="visually-hidden">Search</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              type="search"
              value={search}
            />
          </label>
          <button type="submit">Search</button>
          {query.search === undefined ? null : (
            <button
              onClick={() => {
                setSearch("");
                onChange({ ...query, pagination: resetPage, search: undefined });
              }}
              type="button"
            >
              Clear
            </button>
          )}
        </form>
      ) : null}
      {filterableFields.length === 0 ? null : (
        <div className="collection-filter-builder">
          <select
            aria-label="Filter field"
            onChange={(event) => setFieldId(event.target.value)}
            value={fieldId}
          >
            {filterableFields.map((field) => (
              <option key={field.id} value={field.id}>{field.label}</option>
            ))}
          </select>
          <select
            aria-label="Filter operator"
            onChange={(event) => setOperator(
              event.target.value as AtlasCollectionFilter["operator"],
            )}
            value={operator}
          >
            {(selectedField?.filterOperators ?? []).map((item) => (
              <option key={item} value={item}>{humanizeOperator(item)}</option>
            ))}
          </select>
          {operator === "is-null" || operator === "is-not-null" ? null : (
            <input
              aria-label="Filter value"
              onChange={(event) => setValue(event.target.value)}
              placeholder={operator === "in" || operator === "not-in"
                ? "Comma-separated values"
                : "Value"}
              value={value}
            />
          )}
          <button onClick={addFilter} type="button">Add filter</button>
        </div>
      )}
      {(query.filters ?? []).length === 0 ? null : (
        <div className="collection-filter-list" aria-label="Active filters">
          {(query.filters ?? []).map((filter, index) => (
            <button
              key={`${filter.field}:${filter.operator}:${index}`}
              onClick={() => {
                const filters = (query.filters ?? []).filter(
                  (_item, itemIndex) => itemIndex !== index,
                );
                onChange({
                  ...query,
                  pagination: resetPage,
                  filters: filters.length === 0 ? undefined : filters,
                });
              }}
              title="Remove filter"
              type="button"
            >
              {resource.fields.find((field) => field.id === filter.field)?.label
                ?? filter.field} {humanizeOperator(filter.operator)}{
                filter.value === undefined ? "" : ` ${formatFilterValue(filter.value)}`
              } ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cycles a field through ascending, descending and unsorted states. */
export function getNextSorting(
  sorting: readonly AtlasCollectionSort[],
  field: string,
  append: boolean,
): readonly AtlasCollectionSort[] {
  const current = sorting.find((item) => item.field === field);
  const remaining = append
    ? sorting.filter((item) => item.field !== field)
    : [];

  if (current === undefined) {
    return [...remaining, { field, direction: "asc" }];
  }

  if (current.direction === "asc") {
    return [...remaining, { field, direction: "desc" }];
  }

  return remaining;
}

function createCollectionFilter(
  field: AtlasFieldManifest,
  operator: AtlasCollectionFilter["operator"],
  value: string,
): AtlasCollectionFilter | undefined {
  if (!field.filterOperators.includes(operator)) {
    return undefined;
  }

  if (operator === "is-null" || operator === "is-not-null") {
    return { field: field.id, operator };
  }

  if (value.trim() === "") {
    return undefined;
  }

  const normalizedValue: unknown = operator === "in" || operator === "not-in"
    ? value.split(",").map((item) => normalizeFilterValue(field, item.trim()))
    : normalizeFilterValue(field, value.trim());

  return { field: field.id, operator, value: normalizedValue };
}

function normalizeFilterValue(
  field: AtlasFieldManifest,
  value: string,
): unknown {
  if (field.kind === "number") {
    const number = Number(value);

    return Number.isNaN(number) ? value : number;
  }

  if (field.kind === "boolean") {
    return value === "true" ? true : value === "false" ? false : value;
  }

  return value;
}

function humanizeOperator(operator: string): string {
  return operator.replaceAll("-", " ");
}

function formatFilterValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Stable table region shared by automatic lists and list Views. */
export function ResourceTable({
  fields,
  items,
  manifest,
  onEdit,
  onOpenAction,
  onOpenRelation,
  onRead,
  onSortingChange,
  recordActionsEnabled = true,
  resource,
  sorting = [],
}: {
  fields: readonly AtlasFieldManifest[];
  items: readonly Record<string, unknown>[];
  manifest: AtlasManifest;
  onEdit: (recordId: string) => void;
  onOpenAction: (
    recordId: string,
    action: AtlasRecordActionManifest,
  ) => void;
  onOpenRelation: (resourceId: string, recordId: string) => void;
  onRead: (recordId: string) => void;
  onSortingChange?: (sorting: readonly AtlasCollectionSort[]) => void;
  recordActionsEnabled?: boolean;
  resource: AtlasResourceManifest;
  sorting?: readonly AtlasCollectionSort[];
}) {
  const tablePanel = useRef<HTMLDivElement>(null);
  const [showActionShadow, setShowActionShadow] = useState(false);
  const listActions = resource.recordActions.filter((action) =>
    isRecordActionShownInList(manifest, resource, action));
  const relations = useRelationHydration(manifest, resource, items);

  useEffect(() => {
    const panel = tablePanel.current;

    if (panel === null) {
      return;
    }

    const updateActionShadow = () => setShowActionShadow(
      hasHorizontallyHiddenContentToRight(
        panel.scrollWidth,
        panel.clientWidth,
        panel.scrollLeft,
      ),
    );
    const table = panel.querySelector("table");
    const resizeObserver = new ResizeObserver(updateActionShadow);

    panel.addEventListener("scroll", updateActionShadow, { passive: true });
    resizeObserver.observe(panel);

    if (table !== null) {
      resizeObserver.observe(table);
    }

    updateActionShadow();

    return () => {
      panel.removeEventListener("scroll", updateActionShadow);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div
      className={`table-panel${showActionShadow ? " show-action-shadow" : ""}`}
      ref={tablePanel}
    >
      <table>
        <thead>
          <tr>
            {fields.map((field) => {
              const sortIndex = sorting.findIndex(
                (item) => item.field === field.id,
              );
              const sort = sortIndex < 0 ? undefined : sorting[sortIndex];

              return (
                <th key={field.id}>
                  {field.sortable && onSortingChange !== undefined ? (
                    <button
                      className="column-sort"
                      onClick={(event) => onSortingChange(
                        getNextSorting(sorting, field.id, event.shiftKey),
                      )}
                      title="Click to sort; Shift-click to add another criterion"
                      type="button"
                    >
                      {field.label}
                      {sort === undefined
                        ? null
                        : ` ${sort.direction === "asc" ? "↑" : "↓"}${
                          sorting.length > 1 ? sortIndex + 1 : ""
                        }`}
                    </button>
                  ) : field.label}
                </th>
              );
            })}
            <th className="row-actions-heading">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((record, index) => {
            const identity = record[resource.identity];
            const recordId = String(identity ?? index);

            return (
              <tr key={recordId}>
                {fields.map((field) => (
                  <td key={field.id}>
                    <FieldValue
                      basePath={manifest.basePath}
                      field={field}
                      onOpenRelation={onOpenRelation}
                      relationReferences={relations.references(
                        field,
                        record[field.id],
                      )}
                      resource={resource}
                      value={relations.resolve(field, record[field.id])}
                    />
                  </td>
                ))}
                <td className="row-actions">
                  <div className="row-actions-controls">
                    <button className="button" onClick={() => onRead(recordId)} type="button">
                      <Icon name="view" />
                      View
                    </button>
                    {recordActionsEnabled ? (
                      <RowRecordActions
                        actions={listActions}
                        manifest={manifest}
                        onEdit={() => onEdit(recordId)}
                        onOpenAction={(action) => onOpenAction(recordId, action)}
                        recordId={recordId}
                        resource={resource}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="empty" />
          <span>No records found.</span>
        </div>
      ) : null}
      {relations.error === undefined
        ? null
        : <ErrorState error={relations.error} />}
    </div>
  );
}

/** Detects whether horizontal content remains hidden beyond the right edge. */
export function hasHorizontallyHiddenContentToRight(
  scrollWidth: number,
  clientWidth: number,
  scrollLeft: number,
): boolean {
  // Allow subpixel rounding at browser zoom levels other than 100%.
  return scrollWidth - clientWidth - scrollLeft > 1;
}

/** Provides row-level record Actions and deletion through one compact menu. */
function RowRecordActions({
  actions,
  manifest,
  onEdit,
  onOpenAction,
  recordId,
  resource,
}: {
  actions: readonly AtlasRecordActionManifest[];
  manifest: AtlasManifest;
  onEdit: () => void;
  onOpenAction: (action: AtlasRecordActionManifest) => void;
  recordId: string;
  resource: AtlasResourceManifest;
}) {
  const confirm = useAtlasConfirmation();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => executeAtlasOperation(
      manifest.basePath,
      resource.capabilities.delete,
      { [resource.identity]: recordId },
    ),
    onSuccess: async () => {
      // Refresh every collection and View that may contain the deleted record.
      await queryClient.invalidateQueries({ queryKey: [resource.id] });
    },
  });
  const deleteRecord = async () => {
    if (await confirm({
      confirmLabel: "Delete",
      description: `Delete this ${resource.labelSingular.toLocaleLowerCase()}? This cannot be undone.`,
      title: `Delete ${resource.labelSingular.toLocaleLowerCase()}?`,
      tone: "danger",
    })) {
      remove.mutate();
    }
  };

  return (
    <div className="row-action-menu">
      <RecordActionsMenu
        actions={actions}
        deletePending={remove.isPending}
        manifest={manifest}
        onDelete={deleteRecord}
        onEdit={onEdit}
        onOpenAction={onOpenAction}
        recordId={recordId}
        resource={resource}
      />
      {remove.isError ? <ErrorState error={remove.error} /> : null}
    </div>
  );
}

/** Shared menu used wherever all operations for one record must stay grouped. */
function RecordActionsMenu({
  actions,
  deletePending,
  manifest,
  onDelete,
  onEdit,
  onOpenAction,
  recordId,
  resource,
}: {
  actions: readonly AtlasRecordActionManifest[];
  deletePending: boolean;
  manifest: AtlasManifest;
  onDelete: () => void;
  onEdit?: () => void;
  onOpenAction: (action: AtlasRecordActionManifest) => void;
  recordId: string;
  resource: AtlasResourceManifest;
}) {
  const [dialogAction, setDialogAction] = useState<
    AtlasRecordActionManifest | undefined
  >();

  return (
    <div className="action-menu">
      <Menu.Root>
        <Menu.Trigger className="button">
          <Icon name="actions" />
          Actions
        </Menu.Trigger>
        <Menu.Portal keepMounted>
          <Menu.Positioner
            align="end"
            className="action-menu-positioner"
            side="bottom"
            sideOffset={6}
          >
            <Menu.Popup className="action-menu-list">
              {actions.map((item) => (
                <RecordActionControl
                  item={item}
                  key={item.id}
                  manifest={manifest}
                  onOpenDialog={() => setDialogAction(item)}
                  onOpenPage={() => onOpenAction(item)}
                  recordId={recordId}
                  resource={resource}
                />
              ))}
              {actions.length === 0
                ? null
                : <div className="action-menu-divider" role="separator" />}
              {onEdit === undefined ? null : (
                <Menu.Item className="action-menu-item" onClick={onEdit}>
                  <Icon name="edit" />
                  Edit
                </Menu.Item>
              )}
              <OperationControl
                icon="delete"
                label={deletePending ? "Deleting…" : "Delete"}
                onExecute={onDelete}
                operation={resource.capabilities.delete}
                pending={deletePending}
                role="menuitem"
                tone="danger"
              />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {dialogAction === undefined ? null : (
        <RecordActionDialog
          action={dialogAction}
          manifest={manifest}
          onClose={() => setDialogAction(undefined)}
          recordId={recordId}
          resource={resource}
        />
      )}
    </div>
  );
}

/** Stable numbered-pagination region shared by Resource collections. */
export function ResourcePagination({
  hasNextPage,
  onPageChange,
  page,
}: {
  hasNextPage: boolean;
  onPageChange: (page: number) => void;
  page: number;
}) {
  return (
    <div className="pagination">
      <button
        disabled={page === 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        type="button"
      >
        <Icon name="previous" />
        Previous
      </button>
      <span>Page {page}</span>
      <button
        disabled={!hasNextPage}
        onClick={() => onPageChange(page + 1)}
        type="button"
      >
        Next
        <Icon name="next" />
      </button>
    </div>
  );
}

function RecordActionControl({
  item,
  manifest,
  onOpenDialog,
  onOpenPage,
  recordId,
  resource,
}: {
  item: AtlasRecordActionManifest;
  manifest: AtlasManifest;
  onOpenDialog: () => void;
  onOpenPage: () => void;
  recordId: string;
  resource: AtlasResourceManifest;
}) {
  const confirm = useAtlasConfirmation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trackAction = useAtlasActionFeedback();
  const parameters = getRecordActionParameters(item);
  const mutation = useMutation({
    mutationFn: () => trackAction(
      executeAtlasRecordAction(
        manifest.basePath,
        resource,
        item,
        { [item.recordInput]: recordId },
      ),
      {
        label: item.label,
        ...(item.feedback === undefined ? {} : { feedback: item.feedback }),
      },
    ),
    onSuccess: async (response) => {
      // Refresh the record, main list and every View owned by this Resource.
      await queryClient.invalidateQueries({ queryKey: [resource.id] });
      const redirect = getAtlasRedirectPath(
        manifest,
        response.effects,
      );

      if (redirect !== undefined) {
        void navigate({ to: redirect });
      }
    },
  });
  const execute = async () => {
    if (parameters.length > 0) {
      if (item.presentation === "dialog") {
        onOpenDialog();
      } else {
        onOpenPage();
      }

      return;
    }

    if (item.confirmation !== undefined && !await confirm({
      confirmLabel: item.label,
      description: item.confirmation,
      title: `${item.label}?`,
      tone: item.action.effect === "destructive" ? "danger" : "default",
    })) {
      return;
    }

    mutation.mutate();
  };

  return (
    <div className="record-action">
      <OperationControl
        icon="play"
        label={mutation.isPending ? "Running…" : item.label}
        onExecute={execute}
        operation={item.action}
        pending={mutation.isPending}
        role="menuitem"
      />
      {mutation.isError ? <ErrorState error={mutation.error} /> : null}
    </div>
  );
}

/** Resolves one operation trigger by operation id, then by operation effect. */
export function OperationControl(
  properties: AtlasOperationControlRendererProperties,
) {
  const {
    onExecute,
    operation,
    pending,
    presentation = "menu",
    role,
    tone = "default",
    type = "button",
  } = properties;
  const { operationControls } = useAtlasRendererRegistries();
  const Renderer = resolveAtlasRenderer(operationControls, [
    operation.id,
    operation.effect,
    "default",
  ]) ?? StandardOperationControlContent;
  const className = `${presentation === "primary" ? "button primary" : "action-menu-item"}${
    tone === "danger" ? " danger" : ""
  }`;
  const content = <Renderer {...properties} />;

  if (role === "menuitem") {
    return (
      <Menu.Item
        className={className}
        disabled={pending}
        onClick={onExecute}
      >
        {content}
      </Menu.Item>
    );
  }

  return (
    <button
      className={className}
      disabled={pending}
      onClick={onExecute}
      type={type}
    >
      {content}
    </button>
  );
}

/** Standard content rendered inside the Kestrel-owned interactive control. */
function StandardOperationControlContent({
  icon,
  label,
  operation,
  pending,
}: AtlasOperationControlRendererProperties) {
  return (
    <>
      <Icon
        name={pending
          ? "loading"
          : icon ?? (operation.effect === "destructive" ? "delete" : "play")}
        spin={pending}
      />
      {label}
    </>
  );
}

/** Resolves one schema-derived input through the application registry. */
export function OperationInput(properties: AtlasInputRendererProperties) {
  const { definition, field, resource } = properties;
  const { inputs } = useAtlasRendererRegistries();
  const Renderer = resolveAtlasRenderer(inputs, [
    resource === undefined ? undefined : `${resource.id}.${definition.id}`,
    field?.id,
    field?.kind,
    getOperationInputRendererKey(definition),
    "default",
  ]) ?? StandardOperationInput;

  return <Renderer {...properties} />;
}

/** Standard input retained as the fallback for unregistered schema shapes. */
function StandardOperationInput({
  definition,
  field,
  manifest,
  value,
}: AtlasInputRendererProperties) {
  if (field?.relation !== undefined && manifest !== undefined) {
    return (
      <RelationInput
        definition={definition}
        field={field}
        manifest={manifest}
        value={value}
      />
    );
  }

  const schema = typeof definition.schema === "boolean"
    ? {}
    : definition.schema;
  const label = field?.label ?? humanize(definition.id);
  const commonProperties = {
    id: definition.id,
    name: definition.id,
    required: definition.required,
  };

  if (schema.type === "boolean") {
    return (
      <label className="checkbox-field" htmlFor={definition.id}>
        <input
          {...commonProperties}
          defaultChecked={value === true}
          type="checkbox"
          value="true"
        />
        <span>{label}</span>
      </label>
    );
  }

  const multiline = definition.id.toLocaleLowerCase().includes("description")
    || definition.id.toLocaleLowerCase().includes("content");

  return (
    <label className="form-field" htmlFor={definition.id}>
      <span>{label}{definition.required ? " *" : ""}</span>
      {multiline ? (
        <textarea
          {...commonProperties}
          defaultValue={formatInputValue(value)}
          rows={5}
        />
      ) : (
        <input
          {...commonProperties}
          defaultValue={formatInputValue(value)}
          type={getInputType(schema)}
        />
      )}
    </label>
  );
}

/** Selects the standard input family inferred from one operation parameter. */
function getOperationInputRendererKey(
  definition: AtlasOperationInputManifest,
): string {
  const schema = typeof definition.schema === "boolean"
    ? {}
    : definition.schema;

  if (schema.type === "boolean") {
    return "boolean";
  }

  if (schema.format === "email") {
    return "email";
  }

  if (schema.format === "date") {
    return "date";
  }

  if (schema.format === "date-time") {
    return "datetime";
  }

  if (schema.type === "number" || schema.type === "integer") {
    return "number";
  }

  if (
    definition.id.toLocaleLowerCase().includes("description")
    || definition.id.toLocaleLowerCase().includes("content")
  ) {
    return "multiline";
  }

  return schema.type === "string" ? "text" : "json";
}

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

export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {actions === undefined ? null : <div className="heading-actions">{actions}</div>}
    </header>
  );
}

function LoadingState() {
  return <div className="loading-state">
    <Icon name="loading" spin />
    <span>Loading…</span>
  </div>;
}

function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The operation failed.";

  return <div className="error-state" role="alert">
    <Icon name="warning" />
    <span>{message}</span>
  </div>;
}

/** Reads one schema-derived value, including repeated relation identifiers. */
export function readFormValue(
  form: FormData,
  definition: AtlasOperationInputManifest,
): unknown {
  const schema = typeof definition.schema === "boolean"
    ? {}
    : definition.schema;

  if (schema.type === "boolean") {
    return form.has(definition.id);
  }

  if (schema.type === "array") {
    return form.getAll(definition.id).flatMap((item) =>
      typeof item !== "string" || item === ""
        ? []
        : [coerceFormValue(item, schema.items)]);
  }

  const value = form.get(definition.id);

  if (typeof value !== "string" || value === "") {
    return definition.required ? value : undefined;
  }

  return coerceFormValue(value, schema);
}

function coerceFormValue(value: string, schema: unknown): unknown {
  return typeof schema === "object"
      && schema !== null
      && "type" in schema
      && (schema.type === "number" || schema.type === "integer")
    ? Number(value)
    : value;
}

/** Returns whether schema-derived form values contain user-entered content. */
export function hasAtlasFormContent(values: readonly unknown[]): boolean {
  return values.some((value) =>
    value !== undefined
    && value !== null
    && value !== ""
    && value !== false
    && (!Array.isArray(value) || value.length > 0));
}

function getInputType(schema: Record<string, unknown>): string {
  if (schema.format === "email") {
    return "email";
  }

  if (schema.format === "date") {
    return "date";
  }

  if (schema.format === "date-time") {
    return "datetime-local";
  }

  if (schema.type === "number" || schema.type === "integer") {
    return "number";
  }

  return "text";
}

function formatInputValue(value: unknown): string | number | readonly string[] | undefined {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  return value === undefined || value === null ? undefined : String(value);
}

function humanize(value: string): string {
  const spaced = value.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2");

  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}
