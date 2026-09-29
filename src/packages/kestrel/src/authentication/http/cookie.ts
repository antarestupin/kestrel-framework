import type { AuthenticationConfig } from "../configuration.js";

/** Reads exactly one named cookie and rejects ambiguous duplicates. */
export function readAuthenticationCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

  if (values.length !== 1 || values[0] === "") {
    return undefined;
  }

  try {
    return decodeURIComponent(values[0]!);
  } catch {
    return undefined;
  }
}

/** Serializes the opaque token with explicit browser security attributes. */
export function createAuthenticationCookie(
  token: string,
  config: AuthenticationConfig["http"]["cookie"],
): string {
  return [
    `${config.name}=${encodeURIComponent(token)}`,
    `Path=${config.path}`,
    "HttpOnly",
    config.secure ? "Secure" : undefined,
    `SameSite=${capitalize(config.sameSite)}`,
  ].filter((part) => part !== undefined).join("; ");
}

/** Expires the same host-only cookie regardless of current session validity. */
export function clearAuthenticationCookie(
  config: AuthenticationConfig["http"]["cookie"],
): string {
  return [
    `${config.name}=`,
    `Path=${config.path}`,
    "HttpOnly",
    config.secure ? "Secure" : undefined,
    `SameSite=${capitalize(config.sameSite)}`,
    "Max-Age=0",
  ].filter((part) => part !== undefined).join("; ");
}

function capitalize(value: "lax" | "strict"): "Lax" | "Strict" {
  return value === "lax" ? "Lax" : "Strict";
}
