import { type FormEvent, useState } from "react";

import type { AtlasClientConfig } from "../../client_config.js";
import {
  getAtlasLoginReturnTo,
  signInAtlasWithPassword,
} from "./login_runtime.js";

/** Kestrel-owned username/password page shown before protected data loads. */
export function AtlasLogin(
  { config }: { readonly config: AtlasClientConfig },
) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const authentication = config.authentication;

  if (authentication === undefined) {
    throw new Error(
      "Atlas login page requires authentication configuration.",
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);

    const data = new FormData(event.currentTarget);
    const result = await signInAtlasWithPassword(
      authentication.passwordSignInUrl,
      {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
      },
    );

    if (result.status === "authenticated") {
      window.location.assign(getAtlasLoginReturnTo(
        window.location.search,
        config.basePath,
        authentication.loginPath,
      ));
      return;
    }

    setError(result.status === "rate-limited"
      ? "Too many sign-in attempts. Please try again later."
      : result.status === "untrusted-origin"
      ? "This sign-in page is not trusted from its current address."
      : result.status === "invalid"
      ? "The supplied credentials are invalid."
      : "Sign-in is temporarily unavailable. Please try again.");
    setSubmitting(false);
  };

  return (
    <main className="login-page">
      <section aria-labelledby="login-title" className="login-panel">
        <div aria-hidden="true" className="login-brand-mark">
          {config.title.at(0)}
        </div>
        <p className="eyebrow">Atlas</p>
        <h1 id="login-title">Sign in to {config.title}</h1>
        <p className="login-description">
          Use your Atlas credentials to continue.
        </p>
        <form className="login-form" onSubmit={submit}>
          <label className="form-field">
            <span>Username</span>
            <input
              autoComplete="username"
              autoFocus
              name="username"
              required
              type="text"
            />
          </label>
          <label className="form-field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              name="password"
              required
              type="password"
            />
          </label>
          {error === undefined ? null : (
            <p aria-live="polite" className="login-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={submitting} type="submit">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
