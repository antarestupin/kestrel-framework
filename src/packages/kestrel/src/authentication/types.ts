/** Minimal application-owned entity that can be authenticated. */
export interface AuthenticationSubject {
  readonly id: string;
}

export type AuthenticationAccountState = "active" | "disabled";

/** Kestrel-owned authentication state linked to one application subject. */
export interface AuthenticationAccount {
  readonly id: string;
  readonly subjectId: string;
  readonly state: AuthenticationAccountState;
  readonly securityVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Evidence retained after one or several mechanisms verified an account. */
export interface AuthenticationEvidence {
  readonly method: string;
  readonly factors: readonly string[];
  readonly authenticatedAt: Date;
}

/** Immutable identity exposed to application code for one execution. */
export interface AuthenticatedPrincipal<Claims> {
  readonly accountId: string;
  readonly subjectId: string;
  readonly sessionId: string;
  readonly claims: Readonly<Claims>;
  readonly authentication: {
    readonly methods: readonly string[];
    readonly factors: readonly string[];
    readonly authenticatedAt: Date;
  };
}

/** Application boundary used without prescribing a concrete user model. */
export interface SubjectProvider<Subject extends AuthenticationSubject> {
  findById(id: string): Promise<Subject | null>;
}

