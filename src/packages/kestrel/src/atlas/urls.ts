/** Reject raw separators and control characters before URL parsers normalize them. */
export function hasForbiddenUrlCharacters(value: string): boolean {
  return /[\\\p{White_Space}\p{Cc}\uFEFF]/u.test(value);
}

/** Recognizes a same-origin absolute path before or after normalization. */
export function isAtlasAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !hasForbiddenUrlCharacters(value);
}
