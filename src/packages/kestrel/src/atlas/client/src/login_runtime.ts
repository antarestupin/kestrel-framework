import type {
  AtlasClientAuthenticationConfig,
} from "../../client_config.js";

export interface PasswordSignInInput {
  readonly username: string;
  readonly password: string;
}

/** Result categories intentionally avoid exposing credential-specific details. */
export type PasswordSignInResult =
  | { readonly status: "authenticated" }
  | { readonly status: "invalid" }
  | { readonly status: "untrusted-origin" }
  | { readonly status: "rate-limited" }
  | { readonly status: "unavailable" };

export type AtlasSignOutResult =
  | { readonly status: "signed-out" }
  | { readonly status: "unavailable" };

/** Detects the public login document without loading the protected manifest. */
export function isAtlasLoginPath(
  pathname: string,
  authentication: AtlasClientAuthenticationConfig,
): boolean {
  return pathname === authentication.loginPath;
}

/** Accepts only same-atlas navigation targets and prevents login loops. */
export function getAtlasLoginReturnTo(
  search: string,
  basePath: string,
  loginPath: string,
): string {
  const fallback = basePath;
  const candidate = new URLSearchParams(search).get("returnTo");

  if (
    candidate === null
    || !candidate.startsWith("/")
    || candidate.startsWith("//")
  ) {
    return fallback;
  }

  try {
    const url = new URL(candidate, "http://atlas.local");
    const isBelowBasePath = basePath === "/"
      ? url.pathname.startsWith("/")
      : url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);

    if (
      url.origin !== "http://atlas.local"
      || !isBelowBasePath
      || url.pathname === loginPath
    ) {
      return fallback;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Calls the public password endpoint while mapping failures to safe UI states. */
export async function signInAtlasWithPassword(
  passwordSignInUrl: string,
  input: PasswordSignInInput,
  request: typeof fetch = fetch,
): Promise<PasswordSignInResult> {
  try {
    const response = await request(passwordSignInUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (response.ok) {
      return { status: "authenticated" };
    }
    if (response.status === 401) {
      return { status: "invalid" };
    }
    if (response.status === 403) {
      return { status: "untrusted-origin" };
    }
    if (response.status === 429) {
      return { status: "rate-limited" };
    }

    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Revokes the browser session without treating a transport failure as success. */
export async function signOutAtlas(
  signOutUrl: string,
  request: typeof fetch = fetch,
): Promise<AtlasSignOutResult> {
  try {
    const response = await request(signOutUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });

    return response.ok
      ? { status: "signed-out" }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
