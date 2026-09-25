export type WorkflowPayload =
  | boolean
  | null
  | number
  | string
  | readonly WorkflowPayload[]
  | { readonly [key: string]: WorkflowPayload };

/** Converts runtime values to and from the durable adapter representation. */
export interface WorkflowPayloadCodec {
  encode(value: unknown): Promise<WorkflowPayload> | WorkflowPayload;
  decode(payload: WorkflowPayload): Promise<unknown> | unknown;
}

export class WorkflowPayloadSerializationError extends TypeError {
  public constructor(public readonly path: string, detail: string) {
    super(`Workflow payload at ${path} ${detail}.`);
    this.name = "WorkflowPayloadSerializationError";
  }
}

/** Strict JSON-compatible codec used by workflow clients by default. */
export class JsonWorkflowPayloadCodec implements WorkflowPayloadCodec {
  public encode(value: unknown): WorkflowPayload {
    return encodeJsonValue(value, "$", new WeakSet());
  }

  public decode(payload: WorkflowPayload): unknown {
    // Return an isolated value so callers cannot mutate adapter-owned state.
    return cloneWorkflowPayload(payload);
  }
}

export const jsonWorkflowPayloadCodec = new JsonWorkflowPayloadCodec();

function encodeJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): WorkflowPayload {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowPayloadSerializationError(
        path,
        "must contain a finite number",
      );
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new WorkflowPayloadSerializationError(
      path,
      `contains unsupported ${typeof value}`,
    );
  }

  if (ancestors.has(value)) {
    throw new WorkflowPayloadSerializationError(path, "contains a cycle");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        encodeJsonValue(item, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value) as object | null;

    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowPayloadSerializationError(
        path,
        `contains unsupported instance ${value.constructor.name}`,
      );
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodeJsonValue(item, `${path}.${key}`, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Creates an isolated copy of an already validated durable payload. */
export function cloneWorkflowPayload(
  payload: WorkflowPayload,
): WorkflowPayload {
  if (Array.isArray(payload)) {
    return payload.map(cloneWorkflowPayload);
  }

  if (payload !== null && typeof payload === "object") {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        cloneWorkflowPayload(value),
      ]),
    );
  }

  return payload;
}
