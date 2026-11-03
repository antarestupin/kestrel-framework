/** Truncate visible graphemes, including the ellipsis within the requested limit. */
export function truncateText(text: string, options: { readonly maxLength: number }): string {
  const { maxLength } = options;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new TypeError("maxLength must be a positive safe integer.");
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  const graphemes: string[] = [];
  for (const { segment } of segments) {
    graphemes.push(segment);
    if (graphemes.length > maxLength) return graphemes.slice(0, maxLength - 1).join("") + "…";
  }
  return text;
}
