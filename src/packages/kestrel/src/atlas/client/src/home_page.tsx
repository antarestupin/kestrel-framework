import { Link } from "@tanstack/react-router";

import type { AtlasManifest } from "../../contract.js";
import { CatalogIcon } from "./ui/icon.js";

export interface AtlasHomeProperties {
  manifest: AtlasManifest;
}

/** Renders the lightweight Atlas resource overview. */
export function AtlasHome({ manifest }: AtlasHomeProperties) {
  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Atlas</p>
        <h1>{manifest.title}</h1>
        <p>Manage application resources through their typed contracts.</p>
      </header>
      <div className="resource-grid">
        {manifest.resources.map((resource) => (
          <Link
            className="resource-card"
            key={resource.id}
            to={`/${resource.id}`}
          >
            <span>
              <CatalogIcon
                catalog={manifest.icons}
                fallback="table"
                iconId={resource.icon}
              />
            </span>
            <div>
              <strong>{resource.label}</strong>
              <small>{resource.fields.length} fields</small>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
