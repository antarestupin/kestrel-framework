import { useRef, useState } from "react";

import { Icon } from "../../../client/src/ui/icon.js";
import { ExecutionDetails } from "../../observability/client/execution_details.js";
import type {
  DocumentedAction,
  StudioActionCatalog,
  StudioActionResult,
} from "../contract.js";
import "../../observability/client/styles.css";

type RunnableAction = DocumentedAction & {
  execution: Extract<
    NonNullable<DocumentedAction["execution"]>,
    { enabled: true }
  >;
};

/** Keep execution state bound to one selected action; never retry a request automatically. */
export function ActionRunner({
  action,
  catalog,
  onPendingChange,
}: {
  action: RunnableAction;
  catalog: StudioActionCatalog;
  onPendingChange: (pending: boolean) => void;
}) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [input, setInput] = useState(() =>
    JSON.stringify(action.execution.examples[0]?.input ?? null, null, 2),
  );
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<StudioActionResult>();

  const run = async () => {
    if (inFlight.current) return;
    setError(undefined);
    setResult(undefined);
    let payload: unknown;
    try {
      payload = action.execution.noInput ? null : JSON.parse(input);
    } catch {
      setError("Enter valid JSON before running the action.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    onPendingChange(true);
    try {
      const response = await fetch(catalog.executionPath, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: action.name, input: payload }),
      });
      const body = await response.json();
      if (body.outcome === "success" || body.outcome === "failure") {
        setResult(body as StudioActionResult);
      } else {
        setError(
          typeof body.message === "string"
            ? body.message
            : `Action request failed (${response.status}).`,
        );
      }
    } catch {
      // A lost response cannot tell us whether the server already performed the operation.
      setError(
        "The execution result could not be received. The action may have run; check its effects before retrying.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };

  return (
    <section className="action-runner" aria-label="Run action">
      {!action.execution.noInput && (
        <>
          <label className="action-example-picker">
            <span>Example</span>
            <select
              disabled={pending}
              value={exampleIndex}
              onChange={(event) => {
                const index = Number(event.target.value);
                setExampleIndex(index);
                setInput(
                  JSON.stringify(
                    action.execution.examples[index]!.input,
                    null,
                    2,
                  ),
                );
                setError(undefined);
              }}
            >
              {action.execution.examples.map((example, index) => (
                <option key={index} value={index}>
                  {example.name}
                </option>
              ))}
            </select>
          </label>
          <label className="action-input-label" htmlFor="action-json-input">
            JSON input
          </label>
          <textarea
            id="action-json-input"
            disabled={pending}
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <details className="action-input-schema">
            <summary>Input schema</summary>
            <pre>{JSON.stringify(action.execution.inputSchema, null, 2)}</pre>
          </details>
        </>
      )}
      {action.execution.noInput && (
        <p className="action-runner-note">This action takes no input.</p>
      )}
      <button
        className="action-run-button"
        disabled={pending}
        onClick={() => void run()}
        type="button"
      >
        <Icon name={pending ? "loading" : "play"} spin={pending} />
        {pending ? "Running…" : "Run action"}
      </button>
      {error !== undefined && (
        <p className="action-run-error" role="alert">
          {error}
        </p>
      )}
      {result !== undefined && <ActionRunResult result={result} />}
      {catalog.observability !== undefined && result !== undefined && (
        <section className="action-observations">
          <ExecutionDetails
            dataPath={catalog.observability.dataPath}
            executionId={result.executionId}
            key={result.executionId}
            pollUntilCompleted
          />
        </section>
      )}
    </section>
  );
}

/** Report serialization limitations as a successful execution, never as a retryable failure. */
export function ActionRunResult({ result }: { result: StudioActionResult }) {
  return (
    <section
      className="action-result"
      aria-label="Action result"
      aria-live="polite"
    >
      <header>
        <strong className={result.outcome}>
          {result.outcome === "success" ? "Succeeded" : "Failed"}
        </strong>
        <span>{Math.round(result.durationMs)} ms</span>
      </header>
      {result.outcome === "success" ? (
        result.result.available ? (
          <pre>{JSON.stringify(result.result.value, null, 2)}</pre>
        ) : (
          <p>{result.result.reason}</p>
        )
      ) : (
        <>
          <p className="action-run-error">{result.message}</p>
          {result.issues !== undefined && (
            <ul>
              {result.issues.map((issue, index) => (
                <li key={index}>
                  <code>
                    {issue.path.length === 0 ? "(root)" : issue.path.join(".")}
                  </code>
                  : {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <footer>
        Execution: <code>{result.executionId}</code>
      </footer>
    </section>
  );
}
