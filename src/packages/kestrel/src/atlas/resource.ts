import {
  z,
  type ZodType,
} from "zod";
import type { SvgIconDefinition } from "./icon_definition.js";

import type {
  AtlasFieldKind,
  AtlasFilterOperator,
  AtlasFieldManifest,
  AtlasJsonSchema,
  AtlasOperationEffect,
  AtlasOperationInputManifest,
  AtlasOperationManifest,
  AtlasRecordActionManifest,
  AtlasRecordActionFeedback,
  AtlasRecordActionPresentation,
  AtlasRecordActionsInList,
  AtlasRelatedRecordsFeaturesManifest,
  AtlasRelationCardinality,
  AtlasRelationManifest,
  AtlasResourceManifest,
  AtlasResourceViewManifest,
} from "./contract.js";
import {
  assertIdentifier,
  type CatalogAtlasSource,
  type AtlasOperationReference,
} from "./source.js";
import {
  atlasCollectionQuerySchema,
  createResourceCollectionQuerySchema,
} from "./collection.js";

export interface AtlasFieldOptions {
  readonly label?: string;
  readonly kind?: AtlasFieldKind;
  readonly hidden?: boolean;
  readonly readOnly?: boolean;
  /** Includes this field in the Resource's source-defined text search. */
  readonly searchable?: boolean;
  /** Explicitly allowlists the portable operators exposed for this field. */
  readonly filterable?: boolean | readonly AtlasFilterOperator[];
  /** Allows this field to be selected by the collection sorting contract. */
  readonly sortable?: boolean;
  readonly relation?: AtlasRelationOptions;
}

/** Portable relation metadata declared without persistence-layer objects. */
export interface AtlasRelationOptions {
  readonly resource: string;
  readonly cardinality: AtlasRelationCardinality;
  /** Defaults to `many`, matching the usual foreign-key relation. */
  readonly inverseCardinality?: AtlasRelationCardinality;
  readonly displayField?: string;
  readonly optional?: boolean;
  readonly lookup?: AtlasRelationLookupOptions;
  /** Configures or disables the inverse collection on the target record page. */
  readonly relatedRecords?: false | AtlasRelatedRecordsOptions;
}

export interface AtlasRelatedRecordsFeaturesOptions {
  readonly search?: boolean;
  readonly filters?: boolean;
  readonly sorting?: boolean;
  readonly pagination?: boolean;
  readonly recordActions?: boolean;
}

export interface AtlasRelatedRecordsOptions {
  readonly label?: string;
  readonly pageSize?: number;
  readonly features?: AtlasRelatedRecordsFeaturesOptions;
  /** Overrides the standard filtered list for join-backed relations. */
  readonly query?: AtlasOperationReference;
  /** Query input receiving the identity of the parent record. */
  readonly recordInput?: string;
}

/** Configures bounded candidate search without changing relation identity. */
export interface AtlasRelationLookupOptions {
  readonly query?: AtlasOperationReference<
    typeof atlasCollectionQuerySchema
  >;
  readonly pageSize?: number;
  readonly minimumSearchLength?: number;
}

export interface AtlasResourceCapabilities {
  readonly list: AtlasOperationReference;
  readonly read: AtlasOperationReference;
  readonly readMany: AtlasOperationReference;
  readonly create: AtlasOperationReference;
  readonly update: AtlasOperationReference;
  readonly delete: AtlasOperationReference;
}

export interface AtlasResourceViewOptions {
  readonly label: string;
  readonly query: AtlasOperationReference;
  readonly renderer?: string;
}

/** Declarative Query-backed sub-page owned by a Resource. */
export interface AtlasResourceView extends AtlasResourceViewOptions {}

/** Defines one Resource sub-page independently from its record routes. */
export function defineAtlasResourceView(
  options: AtlasResourceViewOptions,
): AtlasResourceView {
  return { ...options };
}

export interface AtlasRecordActionOptions {
  readonly label: string;
  readonly action: AtlasOperationReference;
  readonly recordInput: string;
  readonly confirmation?: string;
  /** Overrides the default loading, success and error toast messages. */
  readonly feedback?: AtlasRecordActionFeedback;
  readonly presentation?: AtlasRecordActionPresentation;
  readonly showInList?: boolean;
  /** Overrides schema inference and same-named Resource field metadata. */
  readonly inputs?: Readonly<Record<string, AtlasRecordActionInputOptions>>;
}

export type AtlasRecordActionInputOptions = Pick<
  AtlasFieldOptions,
  "kind" | "label" | "relation"
>;

/** Declarative Action displayed on an individual record page. */
export interface AtlasRecordAction extends AtlasRecordActionOptions {}

/** Defines one record Action and its identity input mapping. */
export function defineAtlasRecordAction(
  options: AtlasRecordActionOptions,
): AtlasRecordAction {
  return { ...options };
}

export interface AtlasResourceOptions {
  readonly id: string;
  readonly label: string;
  readonly labelSingular?: string;
  readonly source: CatalogAtlasSource;
  /** Selects the resource icon used by the standard Atlas UI. */
  readonly icon?: SvgIconDefinition;
  readonly identity: string;
  /** Selects the field used to represent one record in the standard UI. */
  readonly displayField?: string;
  readonly capabilities: AtlasResourceCapabilities;
  readonly views?: Readonly<Record<string, AtlasResourceView>>;
  readonly recordActions?: Readonly<Record<string, AtlasRecordAction>>;
  readonly recordActionsInList?: AtlasRecordActionsInList;
  readonly fields?: Readonly<Record<string, AtlasFieldOptions>>;
}

/** Declarative resource definition retained until manifest compilation. */
export interface AtlasResource {
  readonly id: string;
  readonly sourceId: string;
  readonly icon?: SvgIconDefinition;
  getOperationExposures(): readonly AtlasOperationExposure[];
  getRecordActions(): Readonly<Record<string, AtlasRecordAction>>;
  toManifest(): AtlasResourceManifest;
}

/** Server-only operation reference addressed by one stable public id. */
export interface AtlasOperationExposure {
  readonly id: string;
  readonly reference: AtlasOperationReference;
  readonly inputSchema: ZodType;
  /** Selects the Resource whose collection field allowlist guards this input. */
  readonly collectionResourceId?: string;
  readonly collectionConstraints?: {
    readonly firstPageOnly?: boolean;
    readonly maximumPageSize?: number;
    readonly minimumSearchLength?: number;
  };
}

/** Defines one manually mapped CRUD resource. */
export function defineAtlasResource(
  options: AtlasResourceOptions,
): AtlasResource {
  assertIdentifier(options.id, "resource");

  if (options.label.trim() === "") {
    throw new TypeError("An Atlas resource label cannot be empty.");
  }

  if (options.identity.trim() === "") {
    throw new TypeError("An Atlas resource identity cannot be empty.");
  }

  const references = [
    ...Object.values(options.capabilities),
    ...Object.values(options.views ?? {}).map((view) => view.query),
    ...Object.values(options.recordActions ?? {}).map((item) => item.action),
    ...Object.values(options.fields ?? {}).flatMap((field) => {
      const relatedRecords = field.relation?.relatedRecords;

      return relatedRecords !== undefined
          && relatedRecords !== false
          && relatedRecords.query !== undefined
        ? [relatedRecords.query]
        : [];
    }),
  ];

  for (const operation of references) {
    if (operation.sourceId !== options.source.id) {
      throw new TypeError(
        `Atlas resource "${options.id}" contains an operation from source "${operation.sourceId}".`,
      );
    }
  }

  for (const viewId of Object.keys(options.views ?? {})) {
    assertIdentifier(viewId, "view");
  }

  for (const actionId of Object.keys(options.recordActions ?? {})) {
    assertIdentifier(actionId, "record action");
  }

  validateViews(options);
  validateRecordActions(options);
  validateFields(options);
  validateReadMany(options);

  return {
    id: options.id,
    sourceId: options.source.id,
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    getOperationExposures: () => compileOperationExposures(options),
    getRecordActions: () => options.recordActions ?? {},
    toManifest: () => compileResource(options),
  };
}

function compileResource(
  options: AtlasResourceOptions,
): AtlasResourceManifest {
  const readOutputSchema = toJsonSchema(
    options.capabilities.read.outputSchema,
    "output",
  );
  const properties = findObjectProperties(readOutputSchema);

  if (!(options.identity in properties)) {
    throw new TypeError(
      `Atlas resource "${options.id}" identity "${options.identity}" does not exist in its read output.`,
    );
  }

  const writableFields = new Set([
    ...getOperationInputNames(options.capabilities.create),
    ...getOperationInputNames(options.capabilities.update),
  ]);
  // The record identity selects an update target; it is never an editable field.
  writableFields.delete(options.identity);
  const fieldIds = new Set([
    ...Object.keys(properties),
    ...Object.keys(options.fields ?? {}),
  ]);
  const displayField = options.displayField ?? options.identity;

  if (!(displayField in properties)) {
    throw new TypeError(
      `Atlas resource "${options.id}" display field "${displayField}" does not exist in its read output.`,
    );
  }
  const fields = [...fieldIds].map((id) => compileField(
    options.id,
    id,
    properties[id] ?? {},
    writableFields,
    options.fields?.[id],
  ));

  return {
    id: options.id,
    label: options.label,
    labelSingular: options.labelSingular ?? singularize(options.label),
    identity: options.identity,
    displayField,
    sourceId: options.source.id,
    ...(options.recordActionsInList === undefined
      ? {}
      : { recordActionsInList: options.recordActionsInList }),
    fields,
    capabilities: {
      list: compileOperation(
        getCapabilityExposureId(options.id, "list"),
        options.capabilities.list,
      ),
      read: compileOperation(
        getCapabilityExposureId(options.id, "read"),
        options.capabilities.read,
      ),
      readMany: compileOperation(
        getCapabilityExposureId(options.id, "read-many"),
        options.capabilities.readMany,
      ),
      create: compileOperation(
        getCapabilityExposureId(options.id, "create"),
        options.capabilities.create,
      ),
      update: compileOperation(
        getCapabilityExposureId(options.id, "update"),
        options.capabilities.update,
      ),
      delete: compileOperation(
        getCapabilityExposureId(options.id, "delete"),
        options.capabilities.delete,
        "destructive",
      ),
    },
    relatedCollections: [],
    views: Object.entries(options.views ?? {}).map(([id, view]) =>
      compileView(options.id, id, view)),
    recordActions: Object.entries(options.recordActions ?? {}).map(
      ([id, item]) => compileRecordAction(options, id, item),
    ),
  };
}

function compileOperationExposures(
  options: AtlasResourceOptions,
): readonly AtlasOperationExposure[] {
  const fields = compileResource(options).fields;
  const capabilities = Object.entries(options.capabilities).map(
    ([capability, reference]) => ({
      id: getCapabilityExposureId(
        options.id,
        capability === "readMany" ? "read-many" : capability,
      ),
      reference,
      inputSchema: capability === "list"
        ? createResourceCollectionQuerySchema(fields)
        : reference.inputSchema,
      ...(capability === "list"
        ? { collectionResourceId: options.id }
        : {}),
    }),
  );
  const views = Object.entries(options.views ?? {}).map(([id, view]) => ({
    id: getViewExposureId(options.id, id),
    reference: view.query,
    inputSchema: view.query.inputSchema,
  }));

  const relationLookups = Object.entries(options.fields ?? {}).flatMap(
    ([fieldId, field]) => {
      const lookup = field.relation?.lookup?.query;

      return lookup === undefined
        ? []
        : [createRelationLookupExposure(
          getRelationLookupExposureId(options.id, fieldId),
          field.relation!,
          lookup,
        )];
    },
  );
  const relatedRecordQueries = Object.entries(options.fields ?? {}).flatMap(
    ([fieldId, field]) => {
      const relatedRecords = field.relation?.relatedRecords;

      return relatedRecords !== undefined
          && relatedRecords !== false
          && relatedRecords.query !== undefined
        ? [{
          id: getRelatedRecordsExposureId(options.id, fieldId),
          reference: relatedRecords.query,
          inputSchema: relatedRecords.query.inputSchema,
        }]
        : [];
    },
  );
  const recordActionInputLookups = Object.entries(
    options.recordActions ?? {},
  ).flatMap(([actionId, action]) => Object.entries(action.inputs ?? {}).flatMap(
    ([inputId, input]) => {
      const relation = mergeFieldOptions(
        options.fields?.[inputId],
        input,
      ).relation;
      const lookup = relation?.lookup?.query;

      return lookup === undefined
        ? []
        : [createRelationLookupExposure(
          getRecordActionInputLookupExposureId(
            options.id,
            actionId,
            inputId,
          ),
          relation!,
          lookup,
        )];
    }),
  );

  return [
    ...capabilities,
    ...views,
    ...relationLookups,
    ...relatedRecordQueries,
    ...recordActionInputLookups,
  ];
}

function createRelationLookupExposure(
  id: string,
  relation: AtlasRelationOptions,
  lookup: AtlasOperationReference,
): AtlasOperationExposure {
  return {
    id,
    reference: lookup,
    inputSchema: lookup.inputSchema,
    collectionResourceId: relation.resource,
    collectionConstraints: {
      firstPageOnly: true,
      maximumPageSize: relation.lookup?.pageSize ?? 20,
      minimumSearchLength: relation.lookup?.minimumSearchLength ?? 0,
    },
  };
}

function mergeFieldOptions(
  inherited: AtlasFieldOptions | undefined,
  override: AtlasRecordActionInputOptions,
): AtlasFieldOptions {
  return { ...inherited, ...override };
}

function validateViews(options: AtlasResourceOptions): void {
  for (const [id, view] of Object.entries(options.views ?? {})) {
    if (view.label.trim() === "") {
      throw new TypeError(
        `Atlas view "${id}" must have a non-empty label.`,
      );
    }

    if (view.query.effect !== "read") {
      throw new TypeError(
        `Atlas view "${id}" must reference a Query.`,
      );
    }

    assertIdentifier(view.renderer ?? "resource-list", "view renderer");
  }
}

function validateRecordActions(options: AtlasResourceOptions): void {
  for (const [id, item] of Object.entries(options.recordActions ?? {})) {
    if (item.label.trim() === "") {
      throw new TypeError(
        `Atlas record action "${id}" must have a non-empty label.`,
      );
    }

    if (item.action.effect === "read") {
      throw new TypeError(
        `Atlas record action "${id}" must reference an Action.`,
      );
    }

    if (!getOperationInputNames(item.action).includes(item.recordInput)) {
      throw new TypeError(
        `Atlas record action "${id}" input "${item.recordInput}" does not exist.`,
      );
    }

    for (const [state, message] of Object.entries(item.feedback ?? {})) {
      if (message.trim() === "") {
        throw new TypeError(
          `Atlas record action "${id}" feedback message "${state}" cannot be empty.`,
        );
      }
    }

    const inputNames = new Set(getOperationInputNames(item.action));

    for (const [inputId, input] of Object.entries(item.inputs ?? {})) {
      if (!inputNames.has(inputId)) {
        throw new TypeError(
          `Atlas record action "${id}" metadata references unknown input "${inputId}".`,
        );
      }

      if (inputId === item.recordInput) {
        throw new TypeError(
          `Atlas record action "${id}" cannot configure its bound record input "${inputId}".`,
        );
      }

      validateFieldOptions(
        inputId,
        mergeFieldOptions(options.fields?.[inputId], input),
      );
    }

  }
}

function validateFields(options: AtlasResourceOptions): void {
  for (const [id, field] of Object.entries(options.fields ?? {})) {
    validateFieldOptions(id, field);
  }
}

function validateFieldOptions(
  id: string,
  field: AtlasFieldOptions,
): void {
  if (field.kind === "relation" && field.relation === undefined) {
    throw new TypeError(
      `Atlas relation field "${id}" must define its target relation.`,
    );
  }

  if (
    field.relation !== undefined
    && field.kind !== undefined
    && field.kind !== "relation"
  ) {
    throw new TypeError(
      `Atlas field "${id}" cannot combine kind "${field.kind}" with a relation.`,
    );
  }

  if (field.relation?.resource.trim() === "") {
    throw new TypeError(
      `Atlas relation field "${id}" must reference a Resource.`,
    );
  }

  const lookup = field.relation?.lookup;
  const relatedRecords = field.relation?.relatedRecords;

  if (lookup?.query !== undefined && lookup.query.effect !== "read") {
    throw new TypeError(
      `Atlas relation field "${id}" lookup must reference a Query.`,
    );
  }

  if (
    lookup?.pageSize !== undefined
    && (!Number.isInteger(lookup.pageSize)
      || lookup.pageSize < 1
      || lookup.pageSize > 100)
  ) {
    throw new TypeError(
      `Atlas relation field "${id}" lookup page size must be an integer between 1 and 100.`,
    );
  }

  if (relatedRecords !== undefined && relatedRecords !== false) {
    if (field.relation?.inverseCardinality === "one") {
      throw new TypeError(
        `Atlas relation field "${id}" cannot expose related records when its inverse cardinality is "one".`,
      );
    }

    if (relatedRecords.label?.trim() === "") {
      throw new TypeError(
        `Atlas relation field "${id}" related records label cannot be empty.`,
      );
    }

    if (
      relatedRecords.pageSize !== undefined
      && (!Number.isInteger(relatedRecords.pageSize)
        || relatedRecords.pageSize < 1
        || relatedRecords.pageSize > 100)
    ) {
      throw new TypeError(
        `Atlas relation field "${id}" related records page size must be an integer between 1 and 100.`,
      );
    }

    if (relatedRecords.query !== undefined) {
      if (relatedRecords.query.effect !== "read") {
        throw new TypeError(
          `Atlas relation field "${id}" related records operation must reference a Query.`,
        );
      }

      if (relatedRecords.recordInput === undefined) {
        throw new TypeError(
          `Atlas relation field "${id}" related records Query must define its record input.`,
        );
      }

      if (relatedRecords.recordInput === "pagination") {
        throw new TypeError(
          `Atlas relation field "${id}" related records input cannot use the reserved "pagination" name.`,
        );
      }

      const queryInputs = getOperationInputNames(relatedRecords.query);

      if (!queryInputs.includes(relatedRecords.recordInput)) {
        throw new TypeError(
          `Atlas relation field "${id}" related records input "${relatedRecords.recordInput}" does not exist.`,
        );
      }

      if (!queryInputs.includes("pagination")) {
        throw new TypeError(
          `Atlas relation field "${id}" related records Query must accept a "pagination" input.`,
        );
      }

      for (const [feature, input] of [
        [relatedRecords.features?.search ?? true, "search"],
        [relatedRecords.features?.filters ?? true, "filters"],
        [relatedRecords.features?.sorting ?? true, "sorting"],
      ] as const) {
        if (feature === true && !queryInputs.includes(input)) {
          throw new TypeError(
            `Atlas relation field "${id}" enables ${input} but its related records Query does not accept a "${input}" input.`,
          );
        }
      }
    } else if (relatedRecords.recordInput !== undefined) {
      throw new TypeError(
        `Atlas relation field "${id}" cannot define a related records input without a Query.`,
      );
    }
  }

  if (
    lookup?.minimumSearchLength !== undefined
    && (!Number.isInteger(lookup.minimumSearchLength)
      || lookup.minimumSearchLength < 0)
  ) {
    throw new TypeError(
      `Atlas relation field "${id}" lookup minimum search length must be a non-negative integer.`,
    );
  }
}

function validateReadMany(options: AtlasResourceOptions): void {
  const readMany = options.capabilities.readMany;

  if (readMany.effect !== "read") {
    throw new TypeError(
      `Atlas Resource "${options.id}" readMany capability must reference a Query.`,
    );
  }

  if (!getOperationInputNames(readMany).includes("ids")) {
    throw new TypeError(
      `Atlas Resource "${options.id}" readMany capability must accept an "ids" input.`,
    );
  }
}

function compileView(
  resourceId: string,
  id: string,
  view: AtlasResourceView,
): AtlasResourceViewManifest {
  return {
    id,
    label: view.label,
    renderer: view.renderer ?? "resource-list",
    query: compileOperation(getViewExposureId(resourceId, id), view.query),
  };
}

function compileRecordAction(
  options: AtlasResourceOptions,
  id: string,
  item: AtlasRecordAction,
): AtlasRecordActionManifest {
  const inputProperties = findObjectProperties(toJsonSchema(
    item.action.inputSchema,
    "input",
  ));
  const parameterFields = Object.entries(item.inputs ?? {}).map(
    ([inputId, input]) => compileField(
      options.id,
      inputId,
      inputProperties[inputId] ?? {},
      new Set([inputId]),
      mergeFieldOptions(options.fields?.[inputId], input),
      getRecordActionInputLookupExposureId(options.id, id, inputId),
    ),
  );

  return {
    id,
    label: item.label,
    recordInput: item.recordInput,
    presentation: item.presentation ?? "dialog",
    ...(item.showInList === undefined
      ? {}
      : { showInList: item.showInList }),
    ...(item.confirmation === undefined
      ? {}
      : { confirmation: item.confirmation }),
    ...(item.feedback === undefined ? {} : { feedback: item.feedback }),
    ...(parameterFields.length === 0 ? {} : { parameterFields }),
    action: compileOperation(
      getRecordActionExposureId(options.id, id),
      item.action,
    ),
  };
}

function compileOperation(
  id: string,
  reference: AtlasOperationReference,
  effect: AtlasOperationEffect = reference.effect,
): AtlasOperationManifest {
  const { operation } = reference;
  const inputSchema = toJsonSchema(reference.inputSchema, "input");
  const requiredFields = getRequiredFields(inputSchema);
  const inputs = Object.entries(findObjectProperties(inputSchema)).map(
    ([id, schema]): AtlasOperationInputManifest => ({
      id,
      required: requiredFields.has(id),
      schema,
    }),
  );

  return {
    id,
    sourceId: reference.sourceId,
    ...(operation.description === undefined
      ? {}
      : { description: operation.description }),
    effect,
    inputs,
    outputSchema: toJsonSchema(reference.outputSchema, "output"),
  };
}

function compileField(
  resourceId: string,
  id: string,
  schema: AtlasJsonSchema,
  writableFields: ReadonlySet<string>,
  options: AtlasFieldOptions | undefined,
  relationLookupExposureId = getRelationLookupExposureId(resourceId, id),
): AtlasFieldManifest {
  const kind = options?.relation === undefined
    ? options?.kind ?? inferFieldKind(id, schema)
    : "relation";

  return {
    id,
    label: options?.label ?? (options?.relation === undefined
      ? humanize(id)
      : humanizeRelationField(id)),
    kind,
    schema,
    hidden: options?.hidden ?? false,
    readOnly: options?.readOnly ?? !writableFields.has(id),
    searchable: options?.searchable ?? false,
    filterOperators: resolveFilterOperators(
      id,
      kind,
      schemaAllowsNull(schema),
      options?.filterable,
    ),
    sortable: options?.sortable ?? false,
    ...(options?.relation === undefined
      ? {}
      : {
        relation: compileRelation(
          relationLookupExposureId,
          schema,
          options.relation,
        ),
      }),
  };
}

function humanizeRelationField(id: string): string {
  const withoutIdentifierSuffix = id
    .replace(/Ids?$/u, "")
    .replace(/-ids?$/u, "");

  return humanize(withoutIdentifierSuffix || id);
}

function compileRelation(
  lookupExposureId: string,
  schema: AtlasJsonSchema,
  relation: AtlasRelationOptions,
): AtlasRelationManifest {
  return {
    resource: relation.resource,
    cardinality: relation.cardinality,
    inverseCardinality: relation.inverseCardinality ?? "many",
    ...(relation.displayField === undefined
      ? {}
      : { displayField: relation.displayField }),
    optional: relation.optional ?? schemaAllowsNull(schema),
    ...(relation.relatedRecords === undefined
      ? {}
      : relation.relatedRecords === false
        ? { relatedRecords: false as const }
        : {
          relatedRecords: compileRelatedRecords(
            lookupExposureId.replace(/:lookup$/u, ":related-records"),
            relation.relatedRecords,
          ),
        }),
    ...(relation.lookup === undefined
      ? {}
      : {
        lookup: {
          pageSize: relation.lookup.pageSize ?? 20,
          minimumSearchLength: relation.lookup.minimumSearchLength ?? 0,
          ...(relation.lookup.query === undefined
            ? {}
            : {
              operation: compileOperation(
                lookupExposureId,
                relation.lookup.query,
              ),
            }),
        },
      }),
  };
}

function compileRelatedRecords(
  exposureId: string,
  options: AtlasRelatedRecordsOptions,
) {
  const features: AtlasRelatedRecordsFeaturesManifest = {
    search: options.features?.search ?? true,
    filters: options.features?.filters ?? true,
    sorting: options.features?.sorting ?? true,
    pagination: options.features?.pagination ?? true,
    recordActions: options.features?.recordActions ?? true,
  };

  return {
    ...(options.label === undefined ? {} : { label: options.label }),
    pageSize: options.pageSize ?? 10,
    features,
    ...(options.query === undefined
      ? {}
      : { query: compileOperation(exposureId, options.query) }),
    ...(options.recordInput === undefined
      ? {}
      : { recordInput: options.recordInput }),
  };
}

function schemaAllowsNull(schema: AtlasJsonSchema): boolean {
  if (schema === true) {
    return true;
  }

  if (schema === false) {
    return false;
  }

  if (schema.type === "null") {
    return true;
  }

  return ["anyOf", "oneOf"].some((keyword) => {
    const alternatives = schema[keyword];

    return Array.isArray(alternatives) && alternatives.some(
      (alternative) => isJsonSchema(alternative)
        && schemaAllowsNull(alternative),
    );
  });
}

function getOperationInputNames(
  reference: AtlasOperationReference,
): readonly string[] {
  return Object.keys(findObjectProperties(
    toJsonSchema(reference.inputSchema, "input"),
  ));
}

function resolveFilterOperators(
  fieldId: string,
  kind: AtlasFieldKind,
  nullable: boolean,
  filterable: AtlasFieldOptions["filterable"],
): readonly AtlasFilterOperator[] {
  if (filterable === undefined || filterable === false) {
    return [];
  }

  // `true` exposes equality only; applications opt into richer operators.
  const operators = filterable === true
    ? ["equals" as const]
    : [...new Set(filterable)];
  const allowed = getFieldFilterOperators(kind, nullable);

  for (const operator of operators) {
    if (!allowed.includes(operator)) {
      throw new TypeError(
        `Atlas field "${fieldId}" cannot use filter operator "${operator}" with kind "${kind}".`,
      );
    }
  }

  return operators;
}

function getFieldFilterOperators(
  kind: AtlasFieldKind,
  nullable: boolean,
): readonly AtlasFilterOperator[] {
  const nullOperators: readonly AtlasFilterOperator[] = nullable
    ? ["is-null", "is-not-null"]
    : [];

  switch (kind) {
    case "text":
    case "email":
      return [
        "equals", "not-equals", "contains", "starts-with", ...nullOperators,
      ];
    case "id":
    case "relation":
      return ["equals", "not-equals", "in", "not-in", ...nullOperators];
    case "number":
    case "date":
    case "datetime":
      return [
        "equals", "not-equals", "less-than", "less-than-or-equal",
        "greater-than", "greater-than-or-equal", ...nullOperators,
      ];
    case "boolean":
      return ["equals", ...nullOperators];
    case "json":
      return nullOperators;
  }
}

function getCapabilityExposureId(
  resourceId: string,
  capability: string,
): string {
  return `resource:${resourceId}:${capability}`;
}

function getViewExposureId(resourceId: string, viewId: string): string {
  return `resource:${resourceId}:view:${viewId}`;
}

function getRelationLookupExposureId(
  resourceId: string,
  fieldId: string,
): string {
  return `resource:${resourceId}:field:${fieldId}:lookup`;
}

function getRelatedRecordsExposureId(
  resourceId: string,
  fieldId: string,
): string {
  return `resource:${resourceId}:field:${fieldId}:related-records`;
}

function getRecordActionInputLookupExposureId(
  resourceId: string,
  actionId: string,
  inputId: string,
): string {
  return `resource:${resourceId}:record-action:${actionId}:input:${inputId}:lookup`;
}

export function getRecordActionExposureId(
  resourceId: string,
  actionId: string,
): string {
  return `resource:${resourceId}:record-action:${actionId}`;
}

function getRequiredFields(
  schema: AtlasJsonSchema,
): ReadonlySet<string> {
  const objectSchema = findObjectSchema(schema);

  return new Set(
    Array.isArray(objectSchema?.required)
      ? objectSchema.required.filter(
          (field): field is string => typeof field === "string",
        )
      : [],
  );
}

function findObjectProperties(
  schema: AtlasJsonSchema,
): Readonly<Record<string, AtlasJsonSchema>> {
  const objectSchema = findObjectSchema(schema);
  const properties = objectSchema?.properties;

  if (!isRecord(properties)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties).map(([id, value]) => [
      id,
      isJsonSchema(value) ? value : {},
    ]),
  );
}

function findObjectSchema(
  schema: AtlasJsonSchema,
): Record<string, unknown> | undefined {
  if (typeof schema === "boolean") {
    return undefined;
  }

  if (schema.type === "object") {
    return schema;
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];

    if (!Array.isArray(alternatives)) {
      continue;
    }

    for (const alternative of alternatives) {
      if (!isJsonSchema(alternative)) {
        continue;
      }

      const objectSchema = findObjectSchema(alternative);

      if (objectSchema !== undefined) {
        return objectSchema;
      }
    }
  }

  return undefined;
}

function inferFieldKind(
  id: string,
  schema: AtlasJsonSchema,
): AtlasFieldKind {
  if (id === "id") {
    return "id";
  }

  // Date schemas are not representable by JSON Schema in every Zod mode, but
  // conventional timestamp names still provide a useful default renderer.
  if (/(?:At|Date)$/u.test(id)) {
    return "datetime";
  }

  if (typeof schema === "boolean") {
    return "json";
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

  if (schema.type === "boolean") {
    return "boolean";
  }

  if (schema.type === "integer" || schema.type === "number") {
    return "number";
  }

  return schema.type === "string" ? "text" : "json";
}

function toJsonSchema(
  schema: ZodType | undefined,
  io: "input" | "output",
): AtlasJsonSchema {
  if (schema === undefined) {
    return {};
  }

  try {
    return z.toJSONSchema(schema, {
      io,
      unrepresentable: "any",
    });
  } catch {
    // One unrepresentable custom schema must not disable the whole manifest.
    return {};
  }
}

function humanize(value: string): string {
  const words = value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]+/g, " ")
    .trim();

  return words === ""
    ? value
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function singularize(value: string): string {
  return value.endsWith("s") ? value.slice(0, -1) : value;
}

function isJsonSchema(value: unknown): value is AtlasJsonSchema {
  return typeof value === "boolean" || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
