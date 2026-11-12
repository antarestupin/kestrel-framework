import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioLog } from "../contract.js";
import { LogRow } from "./log_row.js";

describe("Studio log rows", () => {
  const event: StudioLog = {
    id: 1, level: 40, loggedAt: "2026-11-12T08:00:00.000Z", createdAt: "2026-11-12T08:00:00.000Z",
    message: "<unsafe>", requestId: "request-1", workload: "scheduled-tasks", payload: { diagnostic: "visible" },
  };

  it("renders structured metadata as escaped text", () => {
    const markup = renderToStaticMarkup(<LogRow log={event} />);
    expect(markup).toContain('class="log-level warn">Warn');
    expect(markup).toContain("Scheduled tasks");
    expect(markup).toContain("&lt;unsafe&gt;");
    expect(markup).toContain("request-1");
    expect(markup).toContain("&quot;diagnostic&quot;");
  });

  it("keeps custom levels and identifies unscoped entries", () => {
    const markup = renderToStaticMarkup(<LogRow log={{ ...event, level: 35, workload: null, message: null, requestId: null }} />);
    expect(markup).toContain('class="log-level 35">35');
    expect(markup).toContain("System");
    expect(markup).toContain("Structured event");
    expect(markup).toContain("<code>—</code>");
  });

  it.each([[10, "Trace"], [20, "Debug"], [30, "Info"], [50, "Error"], [60, "Fatal"]] as const)(
    "uses the standard display label for log level %i",
    (level, label) => {
      const markup = renderToStaticMarkup(<LogRow log={{ ...event, level }} />);
      expect(markup).toContain(`class="log-level ${label.toLowerCase()}">${label}`);
    },
  );

  it("preserves an unrecognized workload from stored logs", () => {
    const historicWorkload = "legacy-job" as StudioLog["workload"];
    const markup = renderToStaticMarkup(<LogRow log={{ ...event, workload: historicWorkload }} />);
    expect(markup).toContain('class="log-workload">legacy-job');
  });
});
