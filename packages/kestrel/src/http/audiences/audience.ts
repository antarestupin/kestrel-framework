/** Audience names are application-owned strings preserved by HTTP contracts. */
export type HttpControllerAudience = string;

export interface HttpControllerAudienceDefinition<
  Audiences extends readonly string[] = readonly string[],
  DefaultAudiences extends readonly Audiences[number][] =
    readonly Audiences[number][],
> {
  /** Complete application-owned audience vocabulary. */
  readonly audiences: Audiences;
  /** Audiences assigned when a controller does not declare its own. */
  readonly defaultAudiences: DefaultAudiences;
}

/**
 * Defines one application audience vocabulary and validates its defaults.
 */
export function defineHttpControllerAudiences<
  const Audiences extends readonly string[],
  const DefaultAudiences extends readonly Audiences[number][],
>(
  options: HttpControllerAudienceDefinition<
    Audiences,
    DefaultAudiences
  >,
): HttpControllerAudienceDefinition<Audiences, DefaultAudiences> {
  assertAudienceList("available", options.audiences, false);
  assertAudienceList("default", options.defaultAudiences, true);

  const availableAudiences = new Set<string>(options.audiences);

  for (const audience of options.defaultAudiences) {
    if (!availableAudiences.has(audience)) {
      throw new TypeError(
        `Unknown default HTTP controller audience: ${audience}.`,
      );
    }
  }

  return options;
}

/** Validates an optional controller selection before storing it. */
export function validateHttpControllerAudienceSelection(
  audiences: readonly string[],
): readonly string[] {
  assertAudienceList("selection", audiences, true);

  return audiences;
}

/** Resolves and validates one controller against an application vocabulary. */
export function resolveHttpControllerAudiences(
  audiences: readonly string[] | undefined,
  definition: HttpControllerAudienceDefinition,
): readonly string[] {
  const resolvedAudiences =
    audiences ?? definition.defaultAudiences;
  const availableAudiences = new Set<string>(definition.audiences);

  for (const audience of resolvedAudiences) {
    if (!availableAudiences.has(audience)) {
      throw new TypeError(
        `Unknown HTTP controller audience: ${audience}.`,
      );
    }
  }

  return resolvedAudiences;
}

/** Validates a nonempty audience filter against the application vocabulary. */
export function validateHttpControllerAudienceFilter(
  definition: HttpControllerAudienceDefinition,
  audiences: readonly string[],
): void {
  assertAudienceList("filter", audiences, false);
  resolveHttpControllerAudiences(audiences, definition);
}

function assertAudienceList(
  kind: string,
  audiences: readonly string[],
  allowEmpty: boolean,
): void {
  if (!allowEmpty && audiences.length === 0) {
    throw new TypeError(
      `The HTTP controller ${kind} audience list cannot be empty.`,
    );
  }

  const uniqueAudiences = new Set<string>();

  for (const audience of audiences) {
    if (audience.trim() === "") {
      throw new TypeError(
        `The HTTP controller ${kind} audience name cannot be empty.`,
      );
    }

    if (uniqueAudiences.has(audience)) {
      throw new TypeError(
        `Duplicate HTTP controller ${kind} audience: ${audience}.`,
      );
    }

    uniqueAudiences.add(audience);
  }
}
