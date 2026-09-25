import { dep } from "../di/index.js";

/** JSON-compatible value that can safely cross diagnostic boundaries. */
export type ExecutionContextValue =
  | boolean
  | null
  | number
  | string
  | readonly ExecutionContextValue[]
  | { readonly [key: string]: ExecutionContextValue };

/** Built-in integrations that can receive diagnostic context values. */
export type ExecutionContextDiagnosticDestination = "log" | "observation";

export interface ExecutionContextEntry {
  readonly key: string;
  /** Internal values intentionally retain their identity and mutability. */
  readonly value: unknown;
  readonly destinations: readonly ExecutionContextDiagnosticDestination[];
}

export interface ExecutionContextDiagnosticOptions {
  /** Log and observation projections both receive diagnostics by default. */
  readonly destinations?: readonly ExecutionContextDiagnosticDestination[];
}

export interface ExecutionContextOptions {
  /** Maximum UTF-8 JSON size of one diagnostic key/value record. */
  readonly maxEntrySizeBytes?: number;
  /** Maximum combined UTF-8 JSON size retained for diagnostics. */
  readonly maxTotalSizeBytes?: number;
}

/** Conservative defaults used when an application does not provide limits. */
export const defaultExecutionContextOptions = Object.freeze({
  maxEntrySizeBytes: 16 * 1_024,
  maxTotalSizeBytes: 64 * 1_024,
} as const satisfies Required<ExecutionContextOptions>);

interface StoredExecutionContextEntry extends ExecutionContextEntry {
  readonly diagnosticSizeBytes: number;
}

const defaultDestinations = Object.freeze([
  "log",
  "observation",
] as const satisfies readonly ExecutionContextDiagnosticDestination[]);
const maxDiagnosticDepth = 100;
const utf8Encoder = new TextEncoder();

/** Completion state remains Kestrel-owned instead of widening the public API. */
const sealedContexts = new WeakSet<ExecutionContext>();

/**
 * Collects internal state and bounded diagnostic information for one execution.
 *
 * Internal values retain their identity. Diagnostic values are instead copied,
 * validated and frozen before logging or observation integrations can read them.
 */
export class ExecutionContext {
  private readonly entriesByKey = new Map<
    string,
    StoredExecutionContextEntry
  >();

  private readonly maxEntrySizeBytes: number;

  private readonly maxTotalSizeBytes: number;

  private diagnosticSizeBytes = 0;

  public constructor(options: ExecutionContextOptions = {}) {
    this.maxEntrySizeBytes = assertPositiveInteger(
      options.maxEntrySizeBytes
        ?? defaultExecutionContextOptions.maxEntrySizeBytes,
      "maxEntrySizeBytes",
    );
    this.maxTotalSizeBytes = assertPositiveInteger(
      options.maxTotalSizeBytes
        ?? defaultExecutionContextOptions.maxTotalSizeBytes,
      "maxTotalSizeBytes",
    );
  }

  /** Replaces one internal value without exporting it to integrations. */
  public set(key: string, value: unknown): void {
    this.assertWritable();
    const normalizedKey = normalizeLabel(key);

    this.replaceEntry(normalizedKey, {
      key: normalizedKey,
      value,
      destinations: [],
      diagnosticSizeBytes: 0,
    });
  }

  /** Appends one internal value while preserving supplied object identities. */
  public append(key: string, value: unknown): void {
    this.assertWritable();
    const normalizedKey = normalizeLabel(key);
    const existing = this.entriesByKey.get(normalizedKey);

    if (existing !== undefined && existing.destinations.length !== 0) {
      throw new TypeError(
        `Cannot append an internal value to diagnostic execution context key "${normalizedKey}".`,
      );
    }

    this.replaceEntry(normalizedKey, {
      key: normalizedKey,
      value: existing === undefined
        ? [value]
        : Array.isArray(existing.value)
          ? [...existing.value, value]
          : [existing.value, value],
      destinations: [],
      diagnosticSizeBytes: 0,
    });
  }

  /** Reads one internal or diagnostic value without exposing mutable storage. */
  public get(key: string): unknown {
    return this.entriesByKey.get(normalizeLabel(key))?.value;
  }

  /** Replaces one JSON-safe value exported to the selected integrations. */
  public setDiagnostic(
    key: string,
    value: ExecutionContextValue,
    options: ExecutionContextDiagnosticOptions = {},
  ): void {
    this.assertWritable();
    const normalizedKey = normalizeLabel(key);
    const normalizedValue = normalizeDiagnosticValue(value);

    this.replaceDiagnosticEntry(
      normalizedKey,
      normalizedValue,
      normalizeDestinations(options.destinations),
    );
  }

  /** Appends one JSON-safe value and combines its integration destinations. */
  public appendDiagnostic(
    key: string,
    value: ExecutionContextValue,
    options: ExecutionContextDiagnosticOptions = {},
  ): void {
    this.assertWritable();
    const normalizedKey = normalizeLabel(key);
    const existing = this.entriesByKey.get(normalizedKey);

    if (existing?.destinations.length === 0) {
      throw new TypeError(
        `Cannot append a diagnostic value to internal execution context key "${normalizedKey}".`,
      );
    }

    const normalizedValue = normalizeDiagnosticValue(value);
    const accumulatedValue = Object.freeze(existing === undefined
      ? [normalizedValue]
      : Array.isArray(existing.value)
        ? [...existing.value, normalizedValue]
        : [existing.value, normalizedValue]) as readonly ExecutionContextValue[];
    const destinations = normalizeDestinations([
      ...(existing?.destinations ?? []),
      ...(options.destinations ?? defaultDestinations),
    ]);

    this.replaceDiagnosticEntry(
      normalizedKey,
      accumulatedValue,
      destinations,
    );
  }

  /**
   * Returns a structurally immutable entry snapshot.
   *
   * Internal values retain their original identity and may remain mutable.
   */
  public entries(
    destination?: ExecutionContextDiagnosticDestination,
  ): readonly ExecutionContextEntry[] {
    const entries = [...this.entriesByKey.values()]
      .filter((entry) => destination === undefined
        || entry.destinations.includes(destination))
      .map((entry) => Object.freeze({
        key: entry.key,
        value: entry.value,
        destinations: Object.freeze([...entry.destinations]),
      }));

    return Object.freeze(entries);
  }

  /** Projects an immutable diagnostic record for one integration. */
  public toRecord(
    destination: ExecutionContextDiagnosticDestination,
  ): Readonly<Record<string, ExecutionContextValue>> {
    return Object.freeze(Object.fromEntries(
      this.entries(destination).map((entry) => [
        entry.key,
        entry.value as ExecutionContextValue,
      ]),
    ));
  }

  private replaceDiagnosticEntry(
    key: string,
    value: ExecutionContextValue,
    destinations: readonly ExecutionContextDiagnosticDestination[],
  ): void {
    const diagnosticSizeBytes = getDiagnosticSizeBytes(key, value);

    if (diagnosticSizeBytes > this.maxEntrySizeBytes) {
      throw new RangeError(
        `Execution context diagnostic "${key}" uses ${diagnosticSizeBytes} bytes, exceeding the ${this.maxEntrySizeBytes}-byte entry limit.`,
      );
    }

    const existingSizeBytes = this.entriesByKey.get(key)
      ?.diagnosticSizeBytes ?? 0;
    const nextTotalSizeBytes = this.diagnosticSizeBytes
      - existingSizeBytes
      + diagnosticSizeBytes;

    if (nextTotalSizeBytes > this.maxTotalSizeBytes) {
      throw new RangeError(
        `Execution context diagnostics would use ${nextTotalSizeBytes} bytes, exceeding the ${this.maxTotalSizeBytes}-byte total limit.`,
      );
    }

    this.replaceEntry(key, {
      key,
      value,
      destinations,
      diagnosticSizeBytes,
    });
  }

  private replaceEntry(
    key: string,
    entry: StoredExecutionContextEntry,
  ): void {
    const existingSizeBytes = this.entriesByKey.get(key)
      ?.diagnosticSizeBytes ?? 0;

    this.entriesByKey.set(key, entry);
    this.diagnosticSizeBytes = this.diagnosticSizeBytes
      - existingSizeBytes
      + entry.diagnosticSizeBytes;
  }

  private assertWritable(): void {
    if (sealedContexts.has(this)) {
      throw new Error("Cannot modify a completed execution context.");
    }
  }
}

/** Seals context membership at the Kestrel-owned completion boundary. */
export function sealExecutionContext(context: ExecutionContext): void {
  sealedContexts.add(context);
}

/** Structured information collector owned by the active execution scope. */
export const executionContextDependency = dep<ExecutionContext>(
  "executionContext",
);

/** Validates and normalizes keys at their public boundary. */
function normalizeLabel(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError("Execution context key cannot be empty.");
  }

  return normalized;
}

/** Removes duplicate destinations while preserving declaration order. */
function normalizeDestinations(
  destinations: readonly ExecutionContextDiagnosticDestination[] =
    defaultDestinations,
): readonly ExecutionContextDiagnosticDestination[] {
  const normalized = [...new Set(destinations)];

  for (const destination of normalized) {
    if (!defaultDestinations.includes(destination)) {
      throw new TypeError(
        `Unknown execution context diagnostic destination "${destination}".`,
      );
    }
  }

  if (normalized.length === 0) {
    throw new TypeError(
      "Execution context diagnostics require at least one destination.",
    );
  }

  return Object.freeze(normalized);
}

/** Copies and freezes the supported JSON subset without invoking toJSON(). */
function normalizeDiagnosticValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth = 0,
): ExecutionContextValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Execution context diagnostics require finite numbers.",
      );
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError(
      `Execution context diagnostics cannot contain ${typeof value} values.`,
    );
  }

  if (depth >= maxDiagnosticDepth) {
    throw new RangeError(
      `Execution context diagnostics cannot exceed ${maxDiagnosticDepth} nested levels.`,
    );
  }

  if (ancestors.has(value)) {
    throw new TypeError("Execution context diagnostics cannot contain cycles.");
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "Execution context diagnostics can contain only arrays and plain objects.",
    );
  }

  const symbols = Object.getOwnPropertySymbols(value);

  if (symbols.length !== 0) {
    throw new TypeError(
      "Execution context diagnostics cannot contain symbol properties.",
    );
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const extraKeys = Object.keys(value).filter((key) =>
        !isArrayIndex(key, value.length));

      if (extraKeys.length !== 0) {
        throw new TypeError(
          "Execution context diagnostic arrays cannot contain named properties.",
        );
      }

      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

        // JSON.stringify() represents sparse array positions as null.
        if (descriptor === undefined) {
          return null;
        }

        if (!("value" in descriptor)) {
          throw new TypeError(
            "Execution context diagnostics cannot contain accessor properties.",
          );
        }

        return normalizeDiagnosticValue(
          descriptor.value,
          ancestors,
          depth + 1,
        );
      }));
    }

    const entries = Object.keys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(
          "Execution context diagnostics cannot contain accessor properties.",
        );
      }

      return [
        key,
        normalizeDiagnosticValue(descriptor.value, ancestors, depth + 1),
      ] as const;
    });

    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

/** Recognizes the enumerable index keys that participate in JSON arrays. */
function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);

  return Number.isInteger(index)
    && index >= 0
    && index < length
    && String(index) === key;
}

/** Counts one complete JSON member so very large keys are bounded as well. */
function getDiagnosticSizeBytes(
  key: string,
  value: ExecutionContextValue,
): number {
  return utf8Encoder.encode(JSON.stringify({ [key]: value })).byteLength;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `Execution context ${name} must be a positive integer.`,
    );
  }

  return value;
}
