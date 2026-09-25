import type { ZodType } from "zod";

const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_TOKEN_NAME_LENGTH = 128;

export type TokenUsage = "multiple" | "single";
export type TokenReplacement = "none" | "same-subject";

/** Declares the application semantics carried by one token kind. */
export interface TokenDefinition<Payload> {
  readonly name: string;
  readonly payloadSchema: ZodType<Payload>;
  readonly usage: TokenUsage;
  readonly strategy: string;
  readonly replacement: TokenReplacement;
  readonly subject?: (payload: Payload) => string | undefined;
}

export interface DefineTokenOptions<Payload> {
  readonly name: string;
  readonly payload: ZodType<Payload>;
  readonly usage?: TokenUsage;
  readonly strategy?: string;
  readonly replacement?: TokenReplacement;
  readonly subject?: (payload: Payload) => string | undefined;
}

/** Defines and validates one immutable, typed token kind. */
export function defineToken<Payload>(
  options: DefineTokenOptions<Payload>,
): TokenDefinition<Payload> {
  validateName(options.name, "Token");
  const strategy = options.strategy ?? "stored";
  validateName(strategy, "Token strategy");
  const replacement = options.replacement ?? "none";

  if (replacement === "same-subject" && options.subject === undefined) {
    throw new TypeError(
      `Token definition "${options.name}" requires a subject resolver when replacement is "same-subject".`,
    );
  }

  return Object.freeze({
    name: options.name,
    payloadSchema: options.payload,
    usage: options.usage ?? "multiple",
    strategy,
    replacement,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  });
}

function validateName(value: string, kind: string): void {
  if (
    value.length > MAX_TOKEN_NAME_LENGTH
    || !TOKEN_NAME_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${kind} name "${value}" must use lowercase dot- or dash-separated segments and be at most ${MAX_TOKEN_NAME_LENGTH} characters.`,
    );
  }
}
