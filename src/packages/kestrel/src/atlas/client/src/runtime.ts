import type {
  AtlasClientEffect,
  AtlasManifest,
  AtlasOperationManifest,
  AtlasOperationResponse,
  AtlasRecordActionManifest,
  AtlasResourceManifest,
} from "../../contract.js";

/** Error returned when Atlas gateway rejects an operation. */
export class AtlasGatewayError extends Error {
  readonly name = "AtlasGatewayError";

  public constructor(
    readonly operationId: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Atlas operation ${operationId} failed with status ${status}.`);
  }
}

/** Executes one serializable manifest operation through the shared gateway. */
export async function executeAtlasOperation<Output>(
  basePath: string,
  operation: AtlasOperationManifest,
  input: Readonly<Record<string, unknown>> = {},
): Promise<Output> {
  const result = await executeAtlasOperationResponse<Output>(
    basePath,
    operation,
    input,
  );

  return result.data;
}

/** Executes an operation while retaining every emitted client effect. */
export function executeAtlasOperationResponse<Output>(
  basePath: string,
  operation: AtlasOperationManifest,
  input: Readonly<Record<string, unknown>> = {},
): Promise<AtlasOperationResponse<Output>> {
  return executeGatewayRequest<Output>(
    `${getAtlasBasePath(basePath)}/api/operations/${
      encodeURIComponent(operation.id)
    }`,
    operation.id,
    input,
  );
}

/** Executes a record Action through its Resource-specific exposure. */
export function executeAtlasRecordAction<Output>(
  basePath: string,
  resource: AtlasResourceManifest,
  action: AtlasRecordActionManifest,
  input: Readonly<Record<string, unknown>> = {},
): Promise<AtlasOperationResponse<Output>> {
  const invocationId = `${resource.id}.${action.id}`;

  return executeGatewayRequest(
    `${getAtlasBasePath(basePath)}/api/resources/${
      encodeURIComponent(resource.id)
    }/record-actions/${encodeURIComponent(action.id)}`,
    invocationId,
    input,
  );
}

/** Resolves the last redirect effect into a canonical client route. */
export function getAtlasRedirectPath(
  manifest: AtlasManifest,
  effects: readonly AtlasClientEffect[],
): string | undefined {
  const redirect = effects.findLast(
    (effect) => effect.type === "redirect",
  );

  if (redirect === undefined) {
    return undefined;
  }

  return getAtlasTargetPath(manifest, redirect.target);
}

/** Builds a canonical path for an effect target. */
export function getAtlasTargetPath(
  manifest: AtlasManifest,
  target: { readonly resource: string; readonly recordId: string },
): string {
  const resource = manifest.resources.find(({ id }) => id === target.resource);

  if (resource === undefined) {
    throw new TypeError(
      `Atlas effect references unknown Resource "${target.resource}".`,
    );
  }

  return `/${resource.id}/${encodeURIComponent(target.recordId)}`;
}

/** Builds an application URL without leaking base-path rules into pages. */
export function getResourcePath(
  basePath: string,
  resource: AtlasResourceManifest,
  suffix = "",
): string {
  return `${basePath === "/" ? "" : basePath}/${resource.id}${suffix}`;
}

/** Returns the configured human-readable value for one Resource record. */
export function getResourceRecordLabel(
  resource: AtlasResourceManifest,
  record: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
): string {
  const value = readAtlasRecordField(record, resource.displayField);

  return value === undefined || value === null || value === ""
    ? fallback
    : String(value);
}

/** A missing field must never resolve to a property of Object.prototype. */
export function readAtlasRecordField(
  record: Readonly<Record<string, unknown>> | undefined,
  field: string,
): unknown {
  return record !== undefined && Object.hasOwn(record, field) ? record[field] : undefined;
}

/** Keeps route IDs as strings unless the receiving operation declares a numeric input. */
export function coerceAtlasRecordId(
  recordId: string,
  operation: AtlasOperationManifest | undefined,
  inputName: string,
): string | number {
  const input = operation?.inputs.find(({ id }) => id === inputName);
  const { schema: { type } } = describeFormInputSchema(input?.schema);
  return (type === "number" || type === "integer") && recordId.trim() !== ""
    ? coerceFormValue(recordId, { type })
    : recordId;
}

/** Places the Resource display field first without disturbing other columns. */
export function getResourceListFields(
  resource: AtlasResourceManifest,
) {
  const visibleFields = resource.fields.filter((field) => !field.hidden);
  const displayField = visibleFields.find(
    (field) => field.id === resource.displayField,
  );

  return displayField === undefined
    ? visibleFields
    : [
      displayField,
      ...visibleFields.filter((field) => field !== displayField),
    ];
}

/** Builds the canonical client route for a Resource record Action. */
export function getRecordActionRoute(
  resource: AtlasResourceManifest,
  recordId: string,
  action: AtlasRecordActionManifest,
): string {
  return `/${resource.id}/${encodeURIComponent(recordId)}/actions/${action.id}`;
}

/** Returns only Action inputs that are not supplied by the record binding. */
export function getRecordActionParameters(
  action: AtlasRecordActionManifest,
) {
  return action.action.inputs.filter((input) => input.id !== action.recordInput);
}

/** Resolves list visibility from Action, Resource, Atlas and Kestrel defaults. */
export function isRecordActionShownInList(
  manifest: AtlasManifest,
  resource: AtlasResourceManifest,
  action: AtlasRecordActionManifest,
): boolean {
  if (action.showInList !== undefined) {
    return action.showInList;
  }

  return (resource.recordActionsInList
    ?? manifest.defaults.recordActionsInList
    ?? "all") === "all";
}

/** Normalizes the root mount before appending client-owned routes. */
export function getAtlasBasePath(basePath: string): string {
  return basePath === "/" ? "" : basePath;
}

/** Narrows conventional list responses before the table consumes them. */
export function readListResult(value: unknown): {
  items: readonly Record<string, unknown>[];
  hasNextPage: boolean;
} {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new TypeError("The resource list operation returned an invalid result.");
  }

  const items = value.items.filter(isRecord);
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : {};

  return {
    items,
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the scalar type shared by form submissions and relation identities. */
export function coerceFormValue(value: string, schema: unknown): string | number {
  const { schema: { format, type } } = describeFormInputSchema(schema);
  if (type === "number" || type === "integer") {
    const number = Number(value);
    // Preserve invalid text for validation because JSON encodes non-finite numbers as null.
    return Number.isFinite(number) ? number : value;
  }
  if (format === "date-time") {
    // A datetime-local control submits the user's wall time without a UTC offset.
    const instant = new Date(value);
    if (Number.isFinite(instant.getTime())) return instant.toISOString();
  }
  return value;
}

/** Selects a concrete control for nullable inputs without guessing between other unions. */
export function describeFormInputSchema(schema: unknown): { schema: Record<string, unknown>; nullable: boolean } {
  if (!isRecord(schema)) return { schema: {}, nullable: schema === true };

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return {
      schema: schema.type.length === 2 ? { ...schema, type: schema.type.find((type) => type !== "null") } : schema,
      nullable: true,
    };
  }

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)
    && alternatives.some((alternative) => isRecord(alternative) && alternative.type === "null")) {
    const alternative = alternatives.length === 2
      ? alternatives.filter(isRecord).find((item) => item.type !== "null")
      : undefined;
    return { schema: alternative ?? schema, nullable: true };
  }

  return { schema, nullable: schema.type === "null" };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === "") {
    return undefined;
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType?.endsWith("+json") !== true) return text;

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // An intermediary can send non-JSON failure details with a stale Content-Type.
    if (response.ok) throw error;
    return text;
  }
}

async function executeGatewayRequest<Output>(
  url: string,
  operationId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<AtlasOperationResponse<Output>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new AtlasGatewayError(operationId, response.status, body);
  }

  if (
    !isRecord(body)
    || !("data" in body)
    || !Array.isArray(body.effects)
  ) {
    throw new TypeError(
      `Atlas operation ${operationId} returned an invalid gateway response.`,
    );
  }

  // Materialize presentation only in browser-owned records, leaving server contracts intact.
  if (isRecord(body.display) && Array.isArray(body.display.labels)) {
    const data = body.data;
    const records = body.display.shape === "array" ? data
      : body.display.shape === "list" && isRecord(data) ? data.items : [data];
    if (!Array.isArray(records) || records.length !== body.display.labels.length) throw new TypeError("Invalid Atlas display metadata.");
    const labels = body.display.labels;
    records.forEach((record, index) => {
      if (!isRecord(record) || typeof labels[index] !== "string") throw new TypeError("Invalid Atlas display label.");
      record.__atlas_display = labels[index];
    });
  }
  return body as unknown as AtlasOperationResponse<Output>;
}
