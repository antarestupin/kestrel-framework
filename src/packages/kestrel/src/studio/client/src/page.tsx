import type { StudioPageManifest } from "../../extension.js";

export interface StudioPageHeaderProperties {
  page: StudioPageManifest;
  eyebrow: string;
}

/**
 * Shared heading displaying the category, title and description of an extension page.
 */
export function StudioPageHeader({
  page,
  eyebrow,
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
    </header>
  );
}
