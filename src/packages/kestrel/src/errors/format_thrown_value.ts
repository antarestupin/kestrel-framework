/** Formats non-Error failures without masking the original rejection. */
export function formatThrownValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    // Null-prototype objects and custom coercion hooks may not be printable.
    return "The thrown value could not be converted to a string.";
  }
}
