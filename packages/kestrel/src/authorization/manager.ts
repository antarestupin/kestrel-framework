import type { AuthenticationContext } from "../authentication/context.js";
import { AuthenticationRequiredError } from "../authentication/errors.js";
import { AuthorizationDeniedError } from "./errors.js";
import type {
  AuthorizationDecision,
  AuthorizationRequirement,
  PermissionResolver,
} from "./types.js";

export interface AuthorizationManagerDependencies {
  readonly authenticationContext: AuthenticationContext<unknown>;
  readonly permissionResolver: PermissionResolver;
}

/** Evaluates requirements once identity has been resolved for an execution. */
export class AuthorizationManager {
  private permissions?: Promise<ReadonlySet<string>>;

  public constructor(
    private readonly dependencies: AuthorizationManagerDependencies,
  ) {}

  public async check(
    requirement: AuthorizationRequirement,
  ): Promise<AuthorizationDecision> {
    const principal = this.dependencies.authenticationContext.getPrincipal();

    if (principal === undefined) {
      throw new AuthenticationRequiredError();
    }

    const permissions = await this.resolvePermissions(principal.subjectId);
    const allowed = evaluate(requirement, permissions);

    return Object.freeze({
      allowed,
      requirement,
      reason: allowed ? "granted" : "missing-permission",
    });
  }

  public async require(requirement: AuthorizationRequirement): Promise<void> {
    const decision = await this.check(requirement);

    if (!decision.allowed) {
      throw new AuthorizationDeniedError();
    }
  }

  private resolvePermissions(subjectId: string): Promise<ReadonlySet<string>> {
    this.permissions ??= this.dependencies.permissionResolver
      .resolvePermissions(subjectId)
      // Retain a private copy so adapter-side mutation cannot alter a decision.
      .then((permissions) => new Set(permissions));

    return this.permissions;
  }
}

function evaluate(
  requirement: AuthorizationRequirement,
  permissions: ReadonlySet<string>,
): boolean {
  if (requirement.type === "permission") {
    return permissions.has(requirement.permission.id);
  }

  if (requirement.type === "all") {
    return requirement.requirements.every((nested) =>
      evaluate(nested, permissions));
  }

  return requirement.requirements.some((nested) =>
    evaluate(nested, permissions));
}
