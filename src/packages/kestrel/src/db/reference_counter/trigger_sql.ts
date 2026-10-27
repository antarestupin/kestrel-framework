import type { ReferenceCounterDefinition } from "./types.js";
import { counterObjectName, quoteIdentifier as quote, tableIdentifier, schemaIdentifier } from "./sql.js";

/** Generates AFTER triggers whose arithmetic updates share the source transaction. */
export function createReferenceCounterTriggerSql(definition: ReferenceCounterDefinition): string {
  const name = counterObjectName(definition);
  const source = tableIdentifier(definition.source);
  const target = tableIdentifier(definition.target.table);
  const functionName = `${schemaIdentifier(definition.target.table)}.${quote(name)}`;
  const key = quote(definition.target.name);
  const reference = quote(definition.reference.name);
  const counter = quote(definition.counter.name);
  const body = `<<counter_state>>
DECLARE
  old_key ${target}.${key}%TYPE;
  new_key ${target}.${key}%TYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF COALESCE((${definition.predicates.old}), false) THEN counter_state.old_key := OLD.${reference}; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF COALESCE((${definition.predicates.new}), false) THEN counter_state.new_key := NEW.${reference}; END IF;
  END IF;
  IF counter_state.old_key IS NOT DISTINCT FROM counter_state.new_key THEN RETURN NULL; END IF;

  -- Lock both destinations in key order before applying a reference transfer.
  PERFORM 1 FROM ${target} AS destination
    WHERE destination.${key} IN (counter_state.old_key, counter_state.new_key)
    ORDER BY destination.${key} FOR NO KEY UPDATE;
  IF counter_state.old_key IS NOT NULL THEN
    UPDATE ${target} AS destination SET ${counter} = destination.${counter} - 1
      WHERE destination.${key} = counter_state.old_key;
  END IF;
  IF counter_state.new_key IS NOT NULL THEN
    UPDATE ${target} AS destination SET ${counter} = destination.${counter} + 1
      WHERE destination.${key} = counter_state.new_key;
  END IF;
  RETURN NULL;
END`;
  // Quote the entire body rather than letting predicate literals end a dollar quote.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS ${literal(body)};
DROP TRIGGER IF EXISTS ${quote(name)} ON ${source};
CREATE TRIGGER ${quote(name)} AFTER INSERT OR UPDATE OR DELETE ON ${source}
FOR EACH ROW EXECUTE FUNCTION ${functionName}();

CREATE OR REPLACE FUNCTION ${schemaIdentifier(definition.target.table)}.${quote(`${name}_key`)}()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS ${literal(`BEGIN
  IF OLD.${key} IS DISTINCT FROM NEW.${key} THEN
    RAISE EXCEPTION 'Reference counter target keys are immutable';
  END IF;
  RETURN NEW;
END`)};
DROP TRIGGER IF EXISTS ${quote(`${name}_key`)} ON ${target};
CREATE TRIGGER ${quote(`${name}_key`)} BEFORE UPDATE OF ${key} ON ${target}
FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier(definition.target.table)}.${quote(`${name}_key`)}();`;
}

/** Cleanup precedes Drizzle DDL so old table and column names remain available. */
export function createReferenceCounterRemovalSql(definition: ReferenceCounterDefinition): string {
  const name = counterObjectName(definition);
  const target = tableIdentifier(definition.target.table);
  const schema = schemaIdentifier(definition.target.table);
  return `DROP TRIGGER IF EXISTS ${quote(name)} ON ${tableIdentifier(definition.source)};
DROP TRIGGER IF EXISTS ${quote(`${name}_key`)} ON ${target};
DROP FUNCTION IF EXISTS ${schema}.${quote(name)}();
DROP FUNCTION IF EXISTS ${schema}.${quote(`${name}_key`)}();`;
}
