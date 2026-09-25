import type { ZodType } from "zod";

import type {
  AuthenticationAccount,
  AuthenticationEvidence,
  AuthenticationSubject,
} from "./types.js";

export interface SessionClaimsContext<
  Subject extends AuthenticationSubject,
> {
  readonly subject: Subject;
  readonly account: AuthenticationAccount;
  readonly evidence: AuthenticationEvidence;
}

export interface DefineAuthenticationOptions<
  Subject extends AuthenticationSubject,
  Claims,
> {
  readonly sessionClaims: {
    readonly schema: ZodType<Claims>;
    readonly create: (
      context: SessionClaimsContext<Subject>,
    ) => Claims | Promise<Claims>;
  };
}

/** Application-specialized authentication contract retained by the provider. */
export interface AuthenticationDefinition<
  Subject extends AuthenticationSubject,
  Claims,
> extends DefineAuthenticationOptions<Subject, Claims> {}

export function defineAuthentication<
  Subject extends AuthenticationSubject,
  Claims,
>(
  options: DefineAuthenticationOptions<Subject, Claims>,
): AuthenticationDefinition<Subject, Claims> {
  return Object.freeze({
    sessionClaims: Object.freeze({ ...options.sessionClaims }),
  });
}

