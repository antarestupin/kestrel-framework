import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionRunResult } from "./action_runner.js";

describe("action execution results", () => {
  it("keeps a successful unrenderable result distinct from an execution failure", () => {
    const markup = renderToStaticMarkup(
      <ActionRunResult
        result={{
          executionId: "run-1",
          durationMs: 12,
          outcome: "success",
          result: {
            available: false,
            reason: "The action succeeded, but its result is not JSON.",
          },
        }}
      />,
    );
    expect(markup).toContain("Succeeded");
    expect(markup).toContain("its result is not JSON");
    expect(markup).not.toContain("Failed");
  });

  it("shows nested field paths and JSON null without treating them as missing results", () => {
    const error = renderToStaticMarkup(
      <ActionRunResult
        result={{
          executionId: "run-2",
          durationMs: 2,
          outcome: "failure",
          message: "Invalid input",
          issues: [{ path: ["items", 0, "name"], message: "Required" }],
        }}
      />,
    );
    expect(error).toContain("items.0.name");
    expect(error).toContain("Required");
    const success = renderToStaticMarkup(
      <ActionRunResult
        result={{
          executionId: "run-3",
          durationMs: 1,
          outcome: "success",
          result: { available: true, value: null },
        }}
      />,
    );
    expect(success).toContain("<pre>null</pre>");
  });
});
