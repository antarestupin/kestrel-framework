import { describe, expect, it } from "vitest";

import { buildActionTree } from "./action_tree.js";

describe("action namespace tree", () => {
  it("preserves root actions, nested namespaces and repeated leaf names without collisions", () => {
    const actions = ["user.profile.update", "user.create", "health", "admin.create", "user"]
      .map((name) => ({ name, middleware: [] }));

    expect(buildActionTree(actions)).toEqual([
      { kind: "group", id: "admin", name: "admin", children: [
        { kind: "action", id: "admin.create", name: "create" },
      ] },
      { kind: "action", id: "health", name: "health" },
      { kind: "action", id: "user", name: "user" },
      { kind: "group", id: "user", name: "user", children: [
        { kind: "action", id: "user.create", name: "create" },
        { kind: "group", id: "user.profile", name: "profile", children: [
          { kind: "action", id: "user.profile.update", name: "update" },
        ] },
      ] },
    ]);
    expect(actions[0]!.name).toBe("user.profile.update");
    expect(buildActionTree([])).toEqual([]);
  });
});
