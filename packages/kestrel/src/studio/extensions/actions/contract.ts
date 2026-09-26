export const ACTIONS_DOCUMENTATION_EXTENSION_ID = "actions-documentation";
export const ACTIONS_DOCUMENTATION_PAGE_KIND = "actions-list";

/** Serializable action representation shared by the Studio API and client. */
export interface DocumentedAction {
  name: string;
  description?: string;
  middleware: readonly string[];
  execution?: StudioActionExecution;
}

/** JSON values are the only values accepted by the Studio action transport. */
export type StudioActionJson =
  | null
  | boolean
  | number
  | string
  | StudioActionJson[]
  | { [key: string]: StudioActionJson };
export type StudioActionJsonSchema = boolean | Record<string, unknown>;

export interface StudioActionExample {
  name: string;
  input: StudioActionJson;
}

export type StudioActionExecution =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      inputSchema: StudioActionJsonSchema;
      noInput: boolean;
      examples: readonly StudioActionExample[];
    };

export interface StudioActionCatalog {
  actions: readonly DocumentedAction[];
  executionPath: string;
  observability?: { dataPath: string };
}

export interface StudioActionIssue {
  path: readonly (string | number)[];
  message: string;
}

/** A display failure is deliberately distinct from an action execution failure. */
export type StudioActionResult = {
  executionId: string;
  durationMs: number;
} & (
  | {
      outcome: "success";
      result:
        | { available: true; value: StudioActionJson }
        | { available: false; reason: string };
    }
  | {
      outcome: "failure";
      message: string;
      issues?: readonly StudioActionIssue[];
    }
);
