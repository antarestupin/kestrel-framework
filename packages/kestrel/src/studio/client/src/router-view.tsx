import {
  Link,
  Outlet,
} from "@tanstack/react-router";

import type {
  StudioManifest,
  StudioPageManifest,
} from "../../extension.js";
import { CatalogIcon, Icon } from "./ui/icon.js";
import { getStudioPageRenderer } from "./extensions.js";
import { buildStudioNavigation } from "./navigation.js";
import { StudioPageHeader } from "./page.js";

interface StudioLayoutProperties {
  manifest: StudioManifest;
}

export function StudioLayout({ manifest }: StudioLayoutProperties) {
  const navigation = buildStudioNavigation(manifest);

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark">S</span>
          <span>
            <strong>Studio</strong>
            <small>Development tools</small>
          </span>
        </Link>

        <nav aria-label="Studio extensions">
          <p className="nav-label">Workspace</p>
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: "nav-link active" }}
            className="nav-link"
            to="/"
          >
            <Icon className="nav-icon" name="home" />
            Overview
          </Link>

          {navigation.map((section) => (
            <section className="nav-section" key={section.definition.id}>
              <p className="nav-label">{section.definition.title}</p>
              {section.items.map((item) => item.type === "page"
                ? (
                  <Link
                    activeProps={{ className: "nav-link active" }}
                    className="nav-link"
                    key={item.key}
                    to={item.definition.path}
                  >
                    <CatalogIcon
                      catalog={manifest.icons}
                      className="nav-icon"
                      fallback="extension"
                      iconId={item.definition.icon}
                    />
                    {item.definition.title}
                  </Link>
                )
                : (
                  <a
                    className="nav-link"
                    href={item.definition.href}
                    key={item.key}
                    rel="noreferrer"
                    target="_blank"
                    title={item.definition.description}
                  >
                    <CatalogIcon
                      catalog={manifest.icons}
                      className="nav-icon"
                      fallback="external-link"
                      iconId={item.definition.icon}
                    />
                    {item.definition.title}
                  </a>
                ))}
            </section>
          ))}
        </nav>

        <div className="environment-badge">
          <Icon name="local" />
          Studio enabled
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

export function StudioHome({ manifest }: StudioLayoutProperties) {
  const toolCount = manifest.extensions.reduce(
    (count, extension) =>
      count
      + extension.pages.filter((page) => page.showInNavigation !== false).length
      + (extension.links?.length ?? 0),
    0,
  );

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Development workspace</p>
        <h1>See how your application is wired.</h1>
        <p className="hero-copy">
          Studio gathers Kestrel introspection and development workflows in
          one development interface.
        </p>
      </header>

      <section className="stats" aria-label="Studio summary">
        <article className="stat-card">
          <span>Extensions</span>
          <strong>{manifest.extensions.length}</strong>
        </article>
        <article className="stat-card">
          <span>Available tools</span>
          <strong>{toolCount}</strong>
        </article>
        <article className="stat-card accent">
          <span>Status</span>
          <strong>Ready</strong>
        </article>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Installed</p>
            <h2>Extensions</h2>
          </div>
        </div>

        <div className="extension-grid">
          {manifest.extensions.map((extension) => (
            <article className="extension-card" key={extension.id}>
              <div className="extension-icon">
                <CatalogIcon
                  catalog={manifest.icons}
                  fallback="extension"
                  iconId={extension.icon}
                />
              </div>
              <div>
                <h3>{extension.title}</h3>
                <p>{extension.description ?? "No description provided."}</p>
                <span>{describeExtensionResources(extension)}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function describeExtensionResources(
  extension: StudioManifest["extensions"][number],
): string {
  const descriptions: string[] = [];

  const visiblePageCount = extension.pages.filter(
    (page) => page.showInNavigation !== false,
  ).length;

  if (visiblePageCount > 0) {
    descriptions.push(
      `${visiblePageCount} page${visiblePageCount === 1 ? "" : "s"}`,
    );
  }

  const linkCount = extension.links?.length ?? 0;

  if (linkCount > 0) {
    descriptions.push(`${linkCount} link${linkCount === 1 ? "" : "s"}`);
  }

  return descriptions.join(" · ") || "No resources";
}

interface StudioPageProperties {
  page: StudioPageManifest;
}

export function StudioPage({ page }: StudioPageProperties) {
  const renderer = getStudioPageRenderer(page.kind);

  if (renderer !== undefined) {
    return renderer.render(page);
  }

  return (
    <div className="page">
      <StudioPageHeader page={page} eyebrow="Extension" />
      <div className="empty-state">
        <Icon name="extension" />
        <h2>Renderer not installed</h2>
        <p>Studio does not know how to display the “{page.kind}” page kind.</p>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="empty-state">
        <Icon name="not-found" />
        <h1>Page not found</h1>
        <Link to="/">Return to Studio overview</Link>
      </div>
    </div>
  );
}
