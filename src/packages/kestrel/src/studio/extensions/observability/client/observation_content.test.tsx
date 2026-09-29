import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioObservation } from "../contract.js";
import { ObservationContent } from "./observation_content.js";

describe("ObservationContent", () => {
  it("renders structured database query details", () => {
    const markup = renderToStaticMarkup(
      <ObservationContent event={observation({
        name: "database.query",
        data: {
          sql: "select id from users where id = $1",
          parameters: ["user-1"],
          command: "SELECT",
          rowCount: 1,
          origin: {
            function: "UserRepository.find",
            file: "/workspace/users.ts",
            line: 42,
            column: 7,
          },
        },
      })} />,
    );

    expect(markup).toContain("database-query-observation");
    expect(markup).toContain("SELECT\n  id\nFROM");
    expect(markup).toContain("$1");
    expect(markup).toContain("UserRepository.find");
    expect(markup).toContain(
      "href=\"vscode://file/workspace/users.ts:42:7\"",
    );
    expect(markup).toContain("Raw observation");
  });

  it("keeps pretty-printed JSON as the fallback renderer", () => {
    const markup = renderToStaticMarkup(
      <ObservationContent event={observation({
        name: "custom.event",
        data: { result: "ok" },
      })} />,
    );

    expect(markup).toContain("observation-json");
    expect(markup).toContain("{\n  &quot;result&quot;: &quot;ok&quot;\n}");
  });
});

function observation(
  overrides: Pick<StudioObservation, "name" | "data">,
): StudioObservation {
  return {
    sequence: 1,
    id: "observation-1",
    executionId: "execution-1",
    occurredAt: "2026-08-17T12:00:00.000Z",
    category: "test",
    schemaVersion: 1,
    outcome: "success",
    durationMs: 1,
    ...overrides,
  };
}
