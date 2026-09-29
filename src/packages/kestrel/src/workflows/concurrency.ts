export type WorkflowConcurrencyConflict =
  | "enqueue"
  | "reject"
  | "return-existing";

export type WorkflowConcurrencyScope = "active-work" | "execution";

export interface WorkflowDefinitionConcurrencyOptions {
  /** Maximum simultaneously reserved tasks across this definition. */
  limit: number;
}

export interface WorkflowKeyedConcurrencyOptions<Input> {
  /** Derives a stable business-resource key from validated workflow input. */
  key: (input: Input) => string;
  limit?: number;
  conflict?: WorkflowConcurrencyConflict;
  scope?: WorkflowConcurrencyScope;
}

export interface WorkflowConcurrencyOptions<Input> {
  executions?: WorkflowDefinitionConcurrencyOptions;
  keyed?: WorkflowKeyedConcurrencyOptions<Input>;
}

/** Function-free concurrency metadata persisted with each execution. */
export interface ResolvedWorkflowConcurrency {
  definitionLimit?: number;
  keyed?: {
    key: string;
    limit: number;
    conflict: WorkflowConcurrencyConflict;
    scope: WorkflowConcurrencyScope;
  };
}

/** Validates static concurrency limits while retaining the typed key function. */
export function validateWorkflowConcurrency<Input>(
  concurrency: WorkflowConcurrencyOptions<Input> | undefined,
): void {
  if (concurrency?.executions !== undefined) {
    validateLimit("definition", concurrency.executions.limit);
  }

  if (concurrency?.keyed !== undefined) {
    validateLimit("keyed", concurrency.keyed.limit ?? 1);
  }
}

/** Resolves a definition's validated input into durable admission metadata. */
export function resolveWorkflowConcurrency<Input>(
  concurrency: WorkflowConcurrencyOptions<Input> | undefined,
  input: Input,
): ResolvedWorkflowConcurrency | undefined {
  if (concurrency === undefined) return undefined;
  const key = concurrency.keyed?.key(input);

  if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
    throw new TypeError("Workflow concurrency keys must be non-empty strings.");
  }

  return {
    ...(concurrency.executions === undefined
      ? {}
      : { definitionLimit: concurrency.executions.limit }),
    ...(concurrency.keyed === undefined || key === undefined
      ? {}
      : {
          keyed: {
            key,
            limit: concurrency.keyed.limit ?? 1,
            conflict: concurrency.keyed.conflict ?? "enqueue",
            scope: concurrency.keyed.scope ?? "execution",
          },
        }),
  };
}

function validateLimit(kind: string, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(
      `Workflow ${kind} concurrency limit must be a positive integer.`,
    );
  }
}
