import type { DocumentedAction } from "../contract.js";

export type ActionTreeNode =
  | { kind: "action"; id: string; name: string }
  | { kind: "group"; id: string; name: string; children: ActionTreeNode[] };

/** Derive nested namespaces from action names without changing the flat API contract. */
export function buildActionTree(actions: readonly DocumentedAction[]): ActionTreeNode[] {
  const roots: ActionTreeNode[] = [];

  for (const action of actions.toSorted((first, second) => first.name.localeCompare(second.name))) {
    const segments = action.name.split(".");
    const name = segments.pop()!;
    let children = roots;
    let path = "";

    for (const segment of segments) {
      path = path === "" ? segment : `${path}.${segment}`;
      let group = children.find((node) => node.kind === "group" && node.name === segment);

      if (group === undefined) {
        group = { kind: "group", id: path, name: segment, children: [] };
        children.push(group);
      }

      if (group.kind === "group") {
        children = group.children;
      }
    }

    // A root action and a namespace may share a name; their node kinds distinguish them.
    children.push({ kind: "action", id: action.name, name });
  }

  return roots;
}
