/** Reject invalid presentation limits before sending the manifest to the browser. */
export function validateTextMaxLength(value: number | false | undefined): void {
  if (value !== undefined && value !== false && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("Atlas textMaxLength must be a positive safe integer or false.");
  }
}

/** Share nullish inheritance between list cells and record labels, preserving false. */
export function resolveTextMaxLength(
  resource: { readonly textMaxLength?: number | false } | undefined,
  globalLimit: number | false | undefined,
): number | false {
  return resource?.textMaxLength ?? globalLimit ?? 50;
}
