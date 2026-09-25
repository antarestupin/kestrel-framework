export const ACTIONS_DOCUMENTATION_EXTENSION_ID = "actions-documentation";
export const ACTIONS_DOCUMENTATION_PAGE_KIND = "actions-list";

/** Serializable action representation shared by the Studio API and client. */
export interface DocumentedAction {
  name: string;
  description?: string;
  middleware: readonly string[];
}
