import {
  describe,
  expect,
  it,
} from "vitest";

import type { StudioManifest } from "../../extension.js";
import { buildStudioNavigation } from "./navigation.js";

describe("buildStudioNavigation", () => {
  it("groups extension resources and applies explicit section and item order", () => {
    const manifest: StudioManifest = {
      basePath: "/_studio",
      icons: {},
      extensions: [
        createExtension("database", "Database", 40, [
          { id: "schema", title: "Database schema", path: "/database", kind: "schema", order: 10 },
        ], [{ id: "drizzle", title: "Drizzle Studio", href: "https://local.drizzle.studio", order: 20 }]),
        createExtension("actions", "App", 20, [
          { id: "actions", title: "Actions", path: "/actions", kind: "actions", order: 10 },
        ]),
        createExtension("logs", "Observability", 30, [
          { id: "logs", title: "Logs", path: "/logs", kind: "logs", order: 20 },
        ]),
        createExtension("workers", "App", 20, [
          { id: "workers", title: "Workers", path: "/workers", kind: "workers", order: 20 },
        ]),
        createExtension("executions", "Observability", 30, [
          { id: "executions", title: "Executions", path: "/executions", kind: "executions", order: 10 },
        ]),
      ],
    };

    const navigation = buildStudioNavigation(manifest);

    expect(navigation.map((section) => section.definition.title)).toEqual([
      "App",
      "Observability",
      "Database",
    ]);
    expect(navigation.map((section) =>
      section.items.map((item) => item.definition.title))).toEqual([
      ["Actions", "Workers"],
      ["Executions", "Logs"],
      ["Database schema", "Drizzle Studio"],
    ]);
  });
});

function createExtension(
  id: string,
  sectionTitle: string,
  sectionOrder: number,
  pages: StudioManifest["extensions"][number]["pages"],
  links?: NonNullable<StudioManifest["extensions"][number]["links"]>,
): StudioManifest["extensions"][number] {
  return {
    id,
    title: id,
    section: {
      id: sectionTitle.toLocaleLowerCase(),
      title: sectionTitle,
      order: sectionOrder,
    },
    pages,
    ...(links === undefined ? {} : { links }),
  };
}
