import { useState } from "react";
import { Link, Outlet } from "@tanstack/react-router";

import type { AtlasClientAuthenticationConfig } from "../../client_config.js";
import type { AtlasManifest } from "../../contract.js";
import { CatalogIcon, Icon } from "./ui/icon.js";
import { signOutAtlas } from "./login_runtime.js";
import { AtlasThemeSelector } from "./theme.js";

export interface AtlasLayoutProperties {
  authentication?: AtlasClientAuthenticationConfig | undefined;
  manifest: AtlasManifest;
}

export function AtlasLayout({
  authentication,
  manifest,
}: AtlasLayoutProperties) {
  return (
    <div className="atlas-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark">{manifest.title.at(0)}</span>
          <span>
            <strong>{manifest.title}</strong>
            <small>Atlas</small>
          </span>
        </Link>
        <nav aria-label="Resources">
          <p className="nav-label">Resources</p>
          {manifest.resources.map((resource) => (
            <div className="nav-resource" key={resource.id}>
              <Link
                activeProps={{ className: "nav-link active" }}
                className="nav-link"
                to={`/${resource.id}`}
              >
                <CatalogIcon
                  catalog={manifest.icons}
                  fallback="table"
                  iconId={resource.icon}
                />
                {resource.label}
              </Link>
              {resource.views.map((view) => (
                <Link
                  activeProps={{ className: "nav-subitem active" }}
                  className="nav-subitem"
                  key={view.id}
                  to={`/${resource.id}/views/${view.id}`}
                >
                  {view.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <AtlasThemeSelector />
          {authentication === undefined
            ? null
            : <AtlasSignOut authentication={authentication} />}
        </div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
  );
}

/** Revokes the current session from the persistent sidebar control. */
export function AtlasSignOut({
  authentication,
}: {
  readonly authentication: AtlasClientAuthenticationConfig;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    setSignOutError(false);
    const result = await signOutAtlas(authentication.signOutUrl);

    if (result.status === "signed-out") {
      window.location.assign(authentication.loginPath);
      return;
    }

    setSignOutError(true);
    setSigningOut(false);
  };

  return (
    <>
      <button
        className="sign-out-button"
        disabled={signingOut}
        onClick={() => void signOut()}
        type="button"
      >
        <Icon name={signingOut ? "loading" : "sign-out"} spin={signingOut} />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
      {signOutError ? (
        <p aria-live="polite" className="sign-out-error" role="alert">
          Sign-out failed. Please try again.
        </p>
      ) : null}
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="empty-state">
        <Icon name="not-found" />
        <h1>Page not found</h1>
        <Link to="/">Return to the overview</Link>
      </div>
    </div>
  );
}
