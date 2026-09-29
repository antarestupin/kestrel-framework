export interface CliOptionBinding {
  readonly kind: "option";
  readonly name?: string;
  readonly repeatable?: boolean;
}

export interface CliParameterBinding {
  readonly kind: "parameter";
  readonly index: number;
}

export type CliInputBinding =
  | CliOptionBinding
  | CliParameterBinding;

/**
 * Explicitly binds an input field to a named CLI option.
 */
export function option(name?: string): CliOptionBinding {
  return name === undefined
    ? { kind: "option" }
    : { kind: "option", name };
}

/** Binds an array input field to an option that may occur several times. */
export function repeatableOption(name?: string): CliOptionBinding {
  return name === undefined
    ? { kind: "option", repeatable: true }
    : { kind: "option", name, repeatable: true };
}

/**
 * Binds an input field to a zero-based positional CLI parameter.
 */
export function param(index: number): CliParameterBinding {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(
      "A CLI parameter index must be a non-negative integer.",
    );
  }

  return {
    kind: "parameter",
    index,
  };
}
