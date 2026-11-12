import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StudioObservation } from "../contract.js";
import { DatabaseQueryObservation } from "./database_query_observation.js";
import { JsonObservation } from "./json_observation.js";
import { ObservationContent } from "./observation_content.js";
import { getObservationRenderer } from "./observation_renderer.js";
import { ObservationRow } from "./observation_row.js";
import { ExecutionGroup } from "./execution_group.js";

describe("ObservationContent", () => {
  it("renders structured database query details", () => {
    const markup = renderToStaticMarkup(
      <ObservationContent event={observation({
        name: "database.query",
        data: {
          sql: "select id from users where id = $1",
          parameters: ["user-1", { flags: true }],
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
    expect(markup).toContain("<code>$2</code>");
    expect(markup).toContain("&quot;flags&quot;: true");
    expect(markup).toContain("<dt>Command</dt><dd>SELECT</dd>");
    expect(markup).toContain("<dt>Rows</dt><dd>1</dd>");
    expect(markup).toContain("UserRepository.find");
    expect(markup).toContain(
      "href=\"vscode://file/workspace/users.ts:42:7\"",
    );
    expect(markup).toContain("Raw observation");
  });

  it("uses the configured editor mapping and omits absent query metadata", () => {
    const document = {
      querySelector: () => ({ dataset: { studioConfig: encodeURIComponent(JSON.stringify({
        basePath: "/studio", sourcePathMapping: { runtimeRoot: "/srv", editorRoot: "/work folder" },
      })) } }),
    };
    vi.stubGlobal("document", document);
    try {
      const markup = renderToStaticMarkup(<ObservationContent event={observation({
        name: "database.query",
        data: { sql: "select 1", origin: { file: "/srv/models.ts", line: 4, column: 1 } },
      })} />);
      expect(markup).toContain('href="vscode://file/work%20folder/models.ts:4:1"');
      expect(markup).toContain("/work folder/models.ts:4");
      expect(markup).not.toContain("<strong>");
      expect(markup).not.toContain("<h4>Parameters</h4>");
      expect(markup).not.toContain("database-query-metadata");
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("uses SQL formatting for the exact query observation identifier", () => {
    expect(getObservationRenderer("database.query")).toBe(DatabaseQueryObservation);
    expect(getObservationRenderer("database.query.finished")).toBe(JsonObservation);
    const sql = "select id from t where name in ('abcdefghijklmnopqrst', 'abcdefghijklmnopqrst', 'abcdefghijklmnopqrst')";
    const markup = renderToStaticMarkup(<ObservationContent event={observation({
      name: "database.query", data: { sql },
    })} />);
    expect(markup).toContain("name IN (&#x27;abcdefghijklmnopqrst&#x27;, &#x27;abcdefghijklmnopqrst&#x27;, &#x27;abcdefghijklmnopqrst&#x27;)");
  });

  it("keeps malformed database diagnostics visible as raw JSON", () => {
    const markup = renderToStaticMarkup(<ObservationContent event={observation({
      name: "database.query", data: { sql: "select 1", parameters: "legacy diagnostic" },
    })} />);
    expect(markup).toContain("observation-json");
    expect(markup).toContain("legacy diagnostic");
  });

  it("renders empty parameters, prepared statement and error metadata without inventing row details", () => {
    const markup = renderToStaticMarkup(<ObservationContent event={observation({
      name: "database.query",
      data: { sql: "select 1", parameters: [], statementName: "check", errorCode: "57014" },
    })} />);
    expect(markup).toContain("No parameters");
    expect(markup).toContain("<dt>Statement</dt><dd>check</dd>");
    expect(markup).toContain("<dt>Error code</dt><dd>57014</dd>");
    expect(markup).not.toContain("<dt>Rows</dt>");
    expect(markup).not.toContain("<dt>Command</dt>");
  });

  it("opens failed observations while distinguishing unset outcome and duration", () => {
    const event = observation({ name: "custom.event", data: {} });
    const failed = renderToStaticMarkup(<ObservationRow event={{ ...event, outcome: "failure" }} showDate />);
    expect(failed).toContain('class="observation-row" open=""');
    expect(failed).toContain('class="observation-outcome failure"');
    expect(failed).toContain(new Date(event.occurredAt).toLocaleString());
    const unset = renderToStaticMarkup(<ObservationRow event={{ ...event, outcome: null, durationMs: null }} />);
    expect(unset).toContain('class="observation-outcome unset">not set');
    expect(unset).not.toContain(' open=""');
    expect(unset).not.toContain(new Date(event.occurredAt).toLocaleDateString());
    expect(unset).toContain(new Date(event.occurredAt).toLocaleTimeString());
  });

  it("shows unattributed items without inventing an execution permalink", () => {
    const markup = renderToStaticMarkup(
      <ExecutionGroup count={1} executionId="unattributed" itemLabel="log" presentation={{ title: "System", details: ["Unscoped"] }}>
        <span>Original log</span>
      </ExecutionGroup>,
    );
    expect(markup).toContain("Unscoped");
    expect(markup).toContain("Original log");
    expect(markup).not.toContain("Open execution");
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
