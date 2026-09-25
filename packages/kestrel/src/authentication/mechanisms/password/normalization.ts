import type { UsernameNormalizer } from "./types.js";

/** Stable case-insensitive normalization used by the initial mechanism. */
export class DefaultUsernameNormalizer implements UsernameNormalizer {
  public normalize(username: string): string {
    return username.trim().normalize("NFKC").toLowerCase();
  }
}

