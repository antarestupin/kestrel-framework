import type { StudioPageManifest } from "../../extension.js";
import { Icon } from "./ui/icon.js";

export interface StudioPageHeaderProperties {
  page: StudioPageManifest;
  eyebrow: string;
  /** Overrides the default read-only capability shown by documentation pages. */
  badge?: string;
}

/**
 * Shared heading primitive for pages contributed by Studio extensions.
 */
export function StudioPageHeader({
  page,
  eyebrow,
  badge = "Read only",
}: StudioPageHeaderProperties) {
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{page.title}</h1>
        {page.description === undefined
          ? null
          : <p>{page.description}</p>}
      </div>
      <span className="read-only-badge">
        <Icon name={badge === "Interactive" ? "interactive" : "lock"} />
        {badge}
      </span>
    </header>
  );
}
