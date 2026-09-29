import type { AuthenticatedPrincipal } from "./types.js";

export type AuthenticationContextState<Claims> =
  | { readonly state: "pending" }
  | { readonly state: "anonymous" }
  | {
      readonly state: "authenticated";
      readonly principal: AuthenticatedPrincipal<Claims>;
    };

/** Owns the authentication result resolved once for one execution scope. */
export class AuthenticationContext<Claims> {
  private current: AuthenticationContextState<Claims> = { state: "pending" };

  public get value(): AuthenticationContextState<Claims> {
    return this.current;
  }

  public resolveAnonymous(): void {
    this.resolve({ state: "anonymous" });
  }

  public resolveAuthenticated(
    principal: AuthenticatedPrincipal<Claims>,
  ): void {
    this.resolve({
      state: "authenticated",
      principal: freezePrincipal(principal),
    });
  }

  public getPrincipal(): AuthenticatedPrincipal<Claims> | undefined {
    return this.current.state === "authenticated"
      ? this.current.principal
      : undefined;
  }

  private resolve(state: AuthenticationContextState<Claims>): void {
    if (this.current.state !== "pending") {
      throw new Error("Authentication context has already been resolved.");
    }

    this.current = Object.freeze(state);
  }
}

function freezePrincipal<Claims>(
  principal: AuthenticatedPrincipal<Claims>,
): AuthenticatedPrincipal<Claims> {
  return Object.freeze({
    ...principal,
    claims: Object.freeze(principal.claims),
    authentication: Object.freeze({
      ...principal.authentication,
      methods: Object.freeze([...principal.authentication.methods]),
      factors: Object.freeze([...principal.authentication.factors]),
    }),
  });
}

