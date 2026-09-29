import { definition as faBolt } from "@fortawesome/free-solid-svg-icons/faBolt";
import { z } from "zod";

import { isAction } from "../../../utils/definitions.js";
import { DEV_OBSERVATIONS_DATA_PATH } from "../observability/contract.js";
import { executeStudioAction } from "./execution.js";
import { generateActionExample, isStudioActionJson } from "./json.js";

import type { StudioExtension } from "../../extension.js";
import { fontAwesomeIcon } from "../../icon_definition.js";
import { defineHttpController, get, post } from "../../../http/index.js";
import { joinStudioPath } from "../../studio.js";
import { studioHttpAccess } from "../../http_access.js";
import {
  ACTIONS_DOCUMENTATION_EXTENSION_ID,
  ACTIONS_DOCUMENTATION_PAGE_KIND,
  type DocumentedAction,
  type StudioActionExecution,
  type StudioActionExample,
  type StudioActionCatalog,
} from "./contract.js";

const actionsIcon = fontAwesomeIcon(faBolt);

export interface ActionDocumentationSource {
  readonly name: string;
  readonly description?: string;
  readonly middleware: readonly { readonly name: string }[];
}

export interface ActionsStudioExtensionOptions {
  /** Execution is enabled by default for complete actions with JSON-compatible inputs. */
  execution?: boolean;
  /** Keep selected actions visible without allowing Studio to run them. */
  exclude?: readonly string[];
  /** Optional JSON examples keyed by the full action name. */
  examples?: Readonly<Record<string, readonly StudioActionExample[]>>;
  /** Requires the application's observation provider and Studio observation extension. */
  observability?: boolean;
}

/**
 * Creates the actions documentation extension from an explicit application
 * action catalog. Explicit registration keeps action discovery IDE-friendly.
 */
export function defineActionsDocumentationExtension(
  actions: readonly ActionDocumentationSource[],
  options: ActionsStudioExtensionOptions = {},
): StudioExtension {
  validateUniqueActionNames(actions);

  const documentedActions = actions
    .map((action) => ({
      ...toDocumentedAction(action),
      execution: documentExecution(action, options),
    }))
    .toSorted((first, second) => first.name.localeCompare(second.name));

  const actionsByName = new Map(actions.map((action) => [action.name, action]));
  const documentedByName = new Map(
    documentedActions.map((action) => [action.name, action]),
  );
  const dataPath = "/api/extensions/actions-documentation/actions";

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
        dataPath,
        order: 10,
      },
    ],
    defineHttpControllers({ basePath }) {
      const root = joinStudioPath(basePath, dataPath);
      return [
        defineHttpController({
          access: studioHttpAccess,
          route: get(root),
          description: "List actions documented by Studio.",
          handler: (): StudioActionCatalog => ({
            actions: documentedActions,
            executionPath: `${root}/execute`,
            ...(options.observability === true
              ? {
                  observability: {
                    dataPath: joinStudioPath(
                      basePath,
                      DEV_OBSERVATIONS_DATA_PATH,
                    ),
                  },
                }
              : {}),
          }),
        }),
        defineHttpController({
          access: studioHttpAccess,
          route: post(`${root}/execute`),
          successStatusCode: 200,
          description:
            "Execute one JSON-compatible action from the Studio catalog.",
          input: z.object({ name: z.string(), input: z.json() }),
          handler: async ({ input, execution, reply }) => {
            const action = actionsByName.get(input.name);
            if (action === undefined) {
              return reply
                .code(404)
                .send({ message: "The action is not registered in Studio." });
            }
            const capability = documentedByName.get(input.name)!.execution;
            // Enforce exactly the same capability at the endpoint and in the UI.
            if (!capability.enabled || !isAction(action)) {
              return reply.code(403).send({
                message: capability.enabled
                  ? "The action is not executable."
                  : capability.reason,
              });
            }
            return executeStudioAction(
              execution,
              action,
              input.input,
              options.observability === true,
            );
          },
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

/** Introspection describes the raw input; it never invokes validation callbacks. */
function documentExecution(
  action: ActionDocumentationSource,
  options: ActionsStudioExtensionOptions,
): StudioActionExecution {
  if (options.execution === false)
    return {
      enabled: false,
      reason: "Action execution is disabled in Studio.",
    };
  if (options.exclude?.includes(action.name))
    return {
      enabled: false,
      reason: "This action is excluded from Studio execution.",
    };
  if (!isAction(action))
    return {
      enabled: false,
      reason: "Only documentation metadata was registered for this action.",
    };

  let inputSchema;
  try {
    // Do not use unrepresentable: "any": a class instance must not become a JSON editor.
    inputSchema = z.toJSONSchema(action.inputSchema, { io: "input" });
  } catch {
    return {
      enabled: false,
      reason:
        "This action input cannot be described as JSON (for example, it requires a class instance).",
    };
  }
  if (inputSchema.not && Object.keys(inputSchema.not).length === 0) {
    return {
      enabled: false,
      reason: "This action input does not accept any value.",
    };
  }
  const configured = options.examples?.[action.name];
  if (configured?.some((example) => !isStudioActionJson(example.input))) {
    throw new TypeError(
      `Studio examples for "${action.name}" must contain JSON values.`,
    );
  }
  return {
    enabled: true,
    inputSchema,
    noInput: inputSchema.type === "null",
    examples: configured?.length
      ? configured
      : [
          {
            name: "Generated example",
            input: generateActionExample(inputSchema),
          },
        ],
  };
}
