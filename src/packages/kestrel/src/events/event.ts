import {
  type input,
  type output,
  type ZodType,
  z,
} from "zod";

const eventDefinitionMarker = Symbol("event-definition");

/** A typed event definition whose concrete schema is intentionally erased. */
export type AnyEventDefinition = EventDefinition<ZodType>;

/** Connects a stable event name to its runtime payload schema. */
export interface EventDefinition<Schema extends ZodType> {
  readonly [eventDefinitionMarker]: true;
  readonly name: string;
  readonly schema: Schema;
}

export interface DefineEventOptions<Schema extends ZodType> {
  name: string;
  schema: Schema;
}

/** The payload accepted when an event is dispatched. */
export type EventInput<Event extends AnyEventDefinition> = input<
  Event["schema"]
>;

/** The parsed payload received by an event listener. */
export type EventPayload<Event extends AnyEventDefinition> = output<
  Event["schema"]
>;

/** Declares a named event while preserving its exact Zod payload schema. */
export function defineEvent<Schema extends ZodType>(
  options: DefineEventOptions<Schema>,
): EventDefinition<Schema> {
  if (options.name.trim().length === 0) {
    throw new TypeError("An event name cannot be empty.");
  }

  return {
    [eventDefinitionMarker]: true,
    name: options.name,
    schema: options.schema,
  };
}

/** Identifies an event terminal value inside a nested catalog. */
export function isEventDefinition(
  value: unknown,
): value is AnyEventDefinition {
  return (
    typeof value === "object"
    && value !== null
    && eventDefinitionMarker in value
    && value[eventDefinitionMarker] === true
  );
}

/** Reports a rejected listener from a fire-and-forget dispatch. */
export const eventListenerFailed = defineEvent({
  name: "events.listenerFailed",
  schema: z.object({
    eventName: z.string(),
    error: z.unknown(),
  }),
});
