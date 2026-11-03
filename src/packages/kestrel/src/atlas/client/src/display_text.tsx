import { truncateText } from "../../display_text.js";

/** Present shortened text without changing its source value or losing its full tooltip. */
export function DisplayText({ text, maxLength }: {
  readonly text: string;
  readonly maxLength: number | false;
}) {
  const visible = maxLength === false ? text : truncateText(text, { maxLength });
  return visible === text ? text : <span title={text}>{visible}</span>;
}
