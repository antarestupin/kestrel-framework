import { definition as faBolt } from "@fortawesome/free-solid-svg-icons/faBolt";

import type { StudioExtension } from "../../extension.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import {
  defineHttpController,
  get,
} from "../../../http/index.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import {
  ACTIONS_DOCUMENTATION_EXTENSION_ID,
  ACTIONS_DOCUMENTATION_PAGE_KIND,
  type DocumentedAction,
} from "./contract.js";

const actionsIcon = fontAwesomeIcon(faBolt);

export interface ActionDocumentationSource {
  readonly name: string;
  readonly description?: string;
  readonly middleware: readonly { readonly name: string }[];
}

/**
 * Creates the actions documentation extension from an explicit application
 * action catalog. Explicit registration keeps action discovery IDE-friendly.
 */
export function defineActionsDocumentationExtension(
  actions: readonly ActionDocumentationSource[],
): StudioExtension {
  validateUniqueActionNames(actions);

  const documentedActions = actions
    .map(toDocumentedAction)
    .toSorted((first, second) =>
      first.name.localeCompare(second.name));

  return {
    id: ACTIONS_DOCUMENTATION_EXTENSION_ID,
    title: "Actions",
    icon: actionsIcon,
    description: "Browse the business operations exposed by the application.",
    section: { id: "app", title: "App", order: 20 },
    pages: [
      {
        id: "list",
        title: "Actions",
        path: "/actions",
        description: "Action contracts registered with Studio.",
        kind: ACTIONS_DOCUMENTATION_PAGE_KIND,
        icon: actionsIcon,
        dataPath: "/api/extensions/actions-documentation/actions",
        order: 10,
      },
    ],
    defineHttpControllers({ basePath }) {
      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(joinStudioPath(
            basePath,
            "/api/extensions/actions-documentation/actions",
          )),
          description: "List actions documented by Studio.",
          handler: () => ({ actions: documentedActions }),
        }),
      ];
    },
  };
}

function validateUniqueActionNames(
  actions: readonly ActionDocumentationSource[],
): void {
  const names = new Set<string>();

  for (const action of actions) {
    if (names.has(action.name)) {
      throw new TypeError(
        `Action "${action.name}" is registered in Studio more than once.`,
      );
    }

    names.add(action.name);
  }
}

function toDocumentedAction(
  action: ActionDocumentationSource,
): DocumentedAction {
  return {
    name: action.name,
    ...(action.description === undefined
      ? {}
      : { description: action.description }),
    middleware: action.middleware.map(({ name }) => name),
  };
}
