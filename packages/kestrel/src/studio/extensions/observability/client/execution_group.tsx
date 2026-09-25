import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getStudioObservationExecutionPath } from "../contract.js";
import type { ExecutionGroupPresentation } from "./execution_grouping.js";

/** Renders one collapsible application execution inside a correlation page. */
export function ExecutionGroup({
  children,
  count,
  executionId,
  itemLabel,
  presentation,
}: {
  children: ReactNode;
  count: number;
  executionId: string;
  itemLabel: string;
  presentation: ExecutionGroupPresentation;
}) {
  return (
    <details className="execution-artifact-group" open>
      <summary>
        <span className="execution-group-heading">
          <strong>{presentation.title}</strong>
          {presentation.details.length > 0 && (
            <span className="execution-group-details">
              {presentation.details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </span>
          )}
        </span>
        <span className="execution-group-count">
          {count} {itemLabel}{count === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="execution-group-identity">
        <code>{executionId}</code>
        {executionId !== "unattributed" && (
          <Link to={getStudioObservationExecutionPath(executionId)}>
            Open execution
          </Link>
        )}
      </div>
      <div className="execution-group-items">{children}</div>
    </details>
  );
}
