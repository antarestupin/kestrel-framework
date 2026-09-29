import { describe, expect, it } from "vitest";

import {
  createVscodeSourceUrl,
  isDatabaseQueryObservationData,
  mapSourceFile,
} from "./database_query_observation_data.js";

describe("database query observation data", () => {
  it("recognizes the minimum stable database query payload", () => {
    expect(isDatabaseQueryObservationData({ sql: "select 1" })).toBe(true);
    expect(isDatabaseQueryObservationData({ query: "select 1" })).toBe(false);
  });

  it("creates an encoded VS Code link for a captured source location", () => {
    expect(createVscodeSourceUrl({
      function: "UserRepository.find",
      file: "/workspace/users/a query#source.ts",
      line: 42,
      column: 7,
    })).toBe(
      "vscode://file/workspace/users/a%20query%23source.ts:42:7",
    );
  });

  it("accepts file URLs and Windows paths from runtime stack traces", () => {
    expect(createVscodeSourceUrl({
      file: "file:///workspace/query.ts",
      line: 10,
      column: 2,
    })).toBe("vscode://file/workspace/query.ts:10:2");

    expect(createVscodeSourceUrl({
      file: "C:\\workspace\\query.ts",
      line: 10,
      column: 2,
    })).toBe("vscode://file/C:/workspace/query.ts:10:2");
  });

  it("maps a container project root to the editor-visible project", () => {
    const mapping = {
      runtimeRoot: "/workspace/agora/",
      editorRoot: "/Users/developer/Projects/agora/",
    };

    expect(mapSourceFile(
      "/workspace/agora/src/kestrel/db/repository.ts",
      mapping,
    )).toBe(
      "/Users/developer/Projects/agora/src/kestrel/db/repository.ts",
    );
    expect(createVscodeSourceUrl({
      file: "/workspace/agora/src/kestrel/db/repository.ts",
      line: 216,
      column: 8,
    }, mapping)).toBe(
      "vscode://file/Users/developer/Projects/agora/src/kestrel/db/repository.ts:216:8",
    );
  });

  it("does not rewrite files outside the configured runtime root", () => {
    expect(mapSourceFile("/workspace/other/file.ts", {
      runtimeRoot: "/workspace/agora",
      editorRoot: "/Users/developer/Projects/agora",
    })).toBe("/workspace/other/file.ts");
  });
});
