import type { ObservationValue } from "../../../../observability/definitions.js";
import { readStudioClientConfig } from "../../../client/src/runtime_config.js";
import type { StudioObservation } from "../contract.js";
import {
  createVscodeSourceUrl,
  isDatabaseQueryObservationData,
  mapSourceFile,
} from "./database_query_observation_data.js";
import { JsonObservation } from "./json_observation.js";
import { formatSqlForDisplay } from "./sql_formatter.js";

const SQL_DISPLAY_WIDTH = 100;

/** Presents database diagnostics without interpolating parameters into SQL. */
export function DatabaseQueryObservation({
  event,
}: {
  event: StudioObservation;
}) {
  if (!isDatabaseQueryObservationData(event.data)) {
    return <JsonObservation event={event} />;
  }

  const data = event.data;
  const sourcePathMapping = readSourcePathMapping();
  const metadata = [
    data.command === undefined ? undefined : ["Command", data.command],
    data.rowCount === undefined ? undefined : ["Rows", String(data.rowCount)],
    data.statementName === undefined
      ? undefined
      : ["Statement", data.statementName],
    data.errorCode === undefined ? undefined : ["Error code", data.errorCode],
  ].filter((item): item is [string, string] => item !== undefined);

  return (
    <div className="database-query-observation">
      <section className="database-query-section">
        <h4>Query</h4>
        <pre className="database-query-sql">
          {formatSqlForDisplay(data.sql, { lineWidth: SQL_DISPLAY_WIDTH })}
        </pre>
      </section>

      {data.parameters !== undefined && (
        <section className="database-query-section">
          <h4>Parameters</h4>
          {data.parameters.length === 0
            ? <p className="database-query-empty">No parameters</p>
            : (
              <ol className="database-query-parameters">
                {data.parameters.map((parameter, index) => (
                  <li key={index}>
                    <code>${index + 1}</code>
                    <pre>{formatObservationValue(parameter)}</pre>
                  </li>
                ))}
              </ol>
            )}
        </section>
      )}

      {data.origin !== undefined && (
        <section className="database-query-section">
          <h4>Called from</h4>
          <div className="database-query-origin">
            {data.origin.function !== undefined && (
              <strong>{data.origin.function}</strong>
            )}
            <a href={createVscodeSourceUrl(
              data.origin,
              sourcePathMapping,
            )}>
              {formatSourceLocation(
                mapSourceFile(data.origin.file, sourcePathMapping),
                data.origin.line,
              )}
            </a>
          </div>
        </section>
      )}

      {metadata.length > 0 && (
        <dl className="database-query-metadata">
          {metadata.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <details className="observation-raw-data">
        <summary>Raw observation</summary>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

function formatObservationValue(value: ObservationValue): string {
  return JSON.stringify(value, null, 2);
}

function readSourcePathMapping() {
  return readStudioClientConfig()?.sourcePathMapping;
}

function formatSourceLocation(file: string, line: number): string {
  return `${file}:${line}`;
}
