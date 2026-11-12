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

  it.each([
    { parameters: "not a list" },
    { statementName: 7 },
    { command: ["SELECT"] },
    { rowCount: "10" },
    { errorCode: 42 },
    { origin: { file: "/src/file.ts", line: "3", column: 1 } },
    { origin: { file: null, line: 3, column: 1 } },
    { origin: { file: "/src/file.ts", line: 3, column: "1" } },
    { origin: { file: "/src/file.ts", line: 3, column: 1, function: [] } },
    { origin: { file: "/src/file.ts", line: 3, column: 1, stack: [1] } },
  ])("rejects malformed optional diagnostic data %j", (options) => {
    expect(isDatabaseQueryObservationData({ sql: "select 1", ...options })).toBe(false);
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

  it("does not encode an already encoded source filename twice", () => {
    expect(createVscodeSourceUrl({
      file: "file:///workspace/query%20%231%3F.ts",
      line: 10,
      column: 2,
    })).toBe("vscode://file/workspace/query%20%231%3F.ts:10:2");
    expect(mapSourceFile("file:///runtime/query%20.ts", {
      runtimeRoot: "/runtime",
      editorRoot: "/editor",
    })).toBe("/editor/query .ts");
    expect(createVscodeSourceUrl({
      file: "file:///workspace/query%.ts", line: 10, column: 2,
    })).toBe("vscode://file/workspace/query%25.ts:10:2");
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

  it("maps a filesystem root and its children without doubling path separators", () => {
    expect(mapSourceFile("/", { runtimeRoot: "/", editorRoot: "/editor" })).toBe("/editor");
    expect(mapSourceFile("/src/query.ts", { runtimeRoot: "/", editorRoot: "/editor" })).toBe("/editor/src/query.ts");
    expect(mapSourceFile("/runtime/query.ts", { runtimeRoot: "/runtime", editorRoot: "/" })).toBe("/query.ts");
  });

  it("maps a Windows runtime root with repeated trailing separators", () => {
    const mapping = { runtimeRoot: "C:\\runtime\\\\", editorRoot: "/editor///" };
    expect(mapSourceFile("C:\\runtime", mapping)).toBe("/editor");
    expect(mapSourceFile("C:\\runtime\\sql.ts", mapping)).toBe("/editor/sql.ts");
    expect(mapSourceFile("C:\\runtime-backup\\sql.ts", mapping)).toBe("C:/runtime-backup/sql.ts");
  });
});
