import type { SvgIconDefinition } from "./icon_definition.js";

/** JSON Schema subset transported to Atlas client. */
export type AtlasJsonSchema = boolean | Record<string, unknown>;

export type AtlasFieldKind =
  | "boolean"
  | "date"
  | "datetime"
  | "email"
  | "id"
  | "json"
  | "number"
  | "relation"
  | "text";

/** Filter operators supported by the portable collection-query contract. */
export type AtlasFilterOperator =
  | "contains"
  | "equals"
  | "greater-than"
  | "greater-than-or-equal"
  | "in"
  | "is-not-null"
  | "is-null"
  | "less-than"
  | "less-than-or-equal"
  | "not-equals"
  | "not-in"
  | "starts-with";

/** One flat filter combined with every other filter through AND. */
export interface AtlasCollectionFilter {
  readonly field: string;
  readonly operator: AtlasFilterOperator;
  readonly value?: unknown | undefined;
}

/** One ordered sorting criterion. */
export interface AtlasCollectionSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** Source-independent state sent by the standard collection client. */
export interface AtlasCollectionQuery {
  readonly pagination: {
    readonly type: "page";
    readonly page: number;
    readonly pageSize: number;
  };
  readonly search?: string | undefined;
  readonly filters?: readonly AtlasCollectionFilter[] | undefined;
  readonly sorting?: readonly AtlasCollectionSort[] | undefined;
}

/** Describes whether one local field contains one or multiple target values. */
export type AtlasRelationCardinality = "many" | "one";

/** Source-independent link from one field to a target Resource. */
export interface AtlasRelationManifest {
  readonly resource: string;
  readonly cardinality: AtlasRelationCardinality;
  /** Number of local records that may reference one target record. */
  readonly inverseCardinality?: AtlasRelationCardinality;
  readonly displayField?: string;
  readonly optional: boolean;
  readonly lookup?: AtlasRelationLookupManifest;
  readonly relatedRecords?: false | AtlasRelatedRecordsManifest;
}

/** Controls which collection features remain available in an embedded list. */
export interface AtlasRelatedRecordsFeaturesManifest {
  readonly search: boolean;
  readonly filters: boolean;
  readonly sorting: boolean;
  readonly pagination: boolean;
  readonly recordActions: boolean;
}

/** Presentation and optional Query override for one inverse relation. */
export interface AtlasRelatedRecordsManifest {
  readonly label?: string;
  readonly pageSize: number;
  readonly features: AtlasRelatedRecordsFeaturesManifest;
  readonly query?: AtlasOperationManifest;
  readonly recordInput?: string;
}

/** One contextual collection rendered below a Resource record. */
export interface AtlasRelatedCollectionManifest {
  readonly id: string;
  readonly label: string;
  readonly resource: string;
  readonly field: string;
  readonly pageSize: number;
  readonly features: AtlasRelatedRecordsFeaturesManifest;
  readonly query?: AtlasOperationManifest;
  readonly recordInput?: string;
}

/** Optional behavior overriding the standard target Resource list picker. */
export interface AtlasRelationLookupManifest {
  readonly operation?: AtlasOperationManifest;
  readonly pageSize: number;
  readonly minimumSearchLength: number;
}

export type AtlasOperationEffect =
  | "read"
  | "write"
  | "destructive";

/** Selects whether record Actions are shown in standard list rows. */
export type AtlasRecordActionsInList = "all" | "none";

/** Selects the default UI used for a parameterized record Action. */
export type AtlasRecordActionPresentation = "dialog" | "page";

/** Static toast messages used while a record Action is running. */
export interface AtlasRecordActionFeedback {
  readonly loading?: string;
  readonly success?: string;
  readonly error?: string;
}

/** Selects the viewport corner used by the standard notification stack. */
export type AtlasNotificationPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface AtlasNotificationsManifest {
  readonly position: AtlasNotificationPosition;
}

/** Client-side effects emitted after a successful atlas Action. */
export type AtlasClientEffect =
  | {
    readonly type: "redirect";
    readonly target: {
      readonly resource: string;
      readonly recordId: string;
    };
  }
  | {
    readonly type: "notification";
    readonly level: "success" | "info" | "warning" | "error";
    readonly message: string;
    readonly link?: {
      readonly label: string;
      readonly target: {
        readonly resource: string;
        readonly recordId: string;
      };
    };
  };

/** Uniform result returned by Atlas operation gateway. */
export interface AtlasOperationResponse<Data = unknown> {
  readonly data: Data;
  readonly effects: readonly AtlasClientEffect[];
}

/** Describes one top-level input accepted by a logical operation. */
export interface AtlasOperationInputManifest {
  readonly id: string;
  readonly required: boolean;
  readonly schema: AtlasJsonSchema;
}

/** Serializable operation executed through Atlas gateway. */
export interface AtlasOperationManifest {
  readonly id: string;
  readonly sourceId: string;
  readonly description?: string;
  readonly effect: AtlasOperationEffect;
  readonly inputs: readonly AtlasOperationInputManifest[];
  readonly outputSchema?: AtlasJsonSchema;
}

/** One Query-backed page nested below a Resource. */
export interface AtlasResourceViewManifest {
  readonly id: string;
  readonly label: string;
  readonly renderer: string;
  readonly query: AtlasOperationManifest;
}

/** One Action displayed while reading an individual record. */
export interface AtlasRecordActionManifest {
  readonly id: string;
  readonly label: string;
  readonly recordInput: string;
  readonly confirmation?: string;
  readonly feedback?: AtlasRecordActionFeedback;
  readonly presentation: AtlasRecordActionPresentation;
  readonly showInList?: boolean;
  /** Explicit parameter metadata overriding same-named Resource fields. */
  readonly parameterFields?: readonly AtlasFieldManifest[];
  readonly action: AtlasOperationManifest;
}

/** Kestrel defaults applied when a Resource or Action has no override. */
export interface AtlasDefaultsManifest {
  readonly recordActionsInList: AtlasRecordActionsInList;
}

/** Presentation and structural metadata for one resource field. */
export interface AtlasFieldManifest {
  readonly id: string;
  readonly label: string;
  readonly kind: AtlasFieldKind;
  readonly schema: AtlasJsonSchema;
  readonly hidden: boolean;
  readonly readOnly: boolean;
  readonly searchable: boolean;
  readonly filterOperators: readonly AtlasFilterOperator[];
  readonly sortable: boolean;
  readonly relation?: AtlasRelationManifest;
}

export interface AtlasResourceCapabilitiesManifest {
  readonly list: AtlasOperationManifest;
  readonly read: AtlasOperationManifest;
  readonly readMany: AtlasOperationManifest;
  readonly create: AtlasOperationManifest;
  readonly update: AtlasOperationManifest;
  readonly delete: AtlasOperationManifest;
}

/** Serializable resource definition consumed by Atlas UI. */
export interface AtlasResourceManifest {
  readonly id: string;
  readonly label: string;
  readonly labelSingular: string;
  readonly identity: string;
  readonly displayField: string;
  readonly sourceId: string;
  readonly recordActionsInList?: AtlasRecordActionsInList;
  readonly icon?: string;
  readonly fields: readonly AtlasFieldManifest[];
  readonly capabilities: AtlasResourceCapabilitiesManifest;
  readonly relatedCollections?: readonly AtlasRelatedCollectionManifest[];
  readonly views: readonly AtlasResourceViewManifest[];
  readonly recordActions: readonly AtlasRecordActionManifest[];
}

/** Complete configuration loaded before the client router is created. */
export interface AtlasManifest {
  readonly basePath: string;
  readonly title: string;
  readonly defaults: AtlasDefaultsManifest;
  readonly notifications: AtlasNotificationsManifest;
  readonly icons: Readonly<Record<string, SvgIconDefinition>>;
  readonly resources: readonly AtlasResourceManifest[];
}
