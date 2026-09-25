export * from "./adapters/index.js";
export {
  AllowAuthenticationAttemptGuard,
  type AuthenticationAttemptGuard,
  type AuthenticationAttemptInput,
} from "./attempt_guard.js";
export {
  authenticationConfigBase,
  type AuthenticationConfig,
} from "./configuration.js";
export {
  AuthenticationContext,
  type AuthenticationContextState,
} from "./context.js";
export {
  defineAuthentication,
  type AuthenticationDefinition,
  type DefineAuthenticationOptions,
  type SessionClaimsContext,
} from "./definition.js";
export {
  authenticationAdapterDependency,
  authenticationContextDependency,
  authenticationManagerDependency,
  authenticationSubjectProviderDependency,
  passwordHasherDependency,
  passwordMechanismDependency,
} from "./dependencies.js";
export {
  AuthenticationRequiredError,
  AuthenticationRateLimitedError,
  InvalidCredentialsError,
  UntrustedAuthenticationOriginError,
} from "./errors.js";
export {
  createAuthenticationActions,
  passwordSignInHttpInputSchema,
  passwordSignInInputSchema,
} from "./actions.js";
export * from "./http/index.js";
export * from "./guards/index.js";
export {
  AuthenticationManager,
  type AuthenticationAttemptMetadata,
  type AuthenticationManagerDependencies,
  type AuthenticationManagerOptions,
  type SessionGrant,
} from "./manager.js";
export * from "./mechanisms/index.js";
export { requireAuthentication } from "./middleware.js";
export { AuthenticationProvider } from "./provider.js";
export type { AuthenticationProof } from "./proof.js";
export type {
  AccountStore,
  AuthenticationAdapter,
  CreateAuthenticationAccount,
  CreatePasswordCredential,
  CreateStoredSession,
  PasswordCredential,
  PasswordCredentialStore,
  ReplacePasswordHash,
  ResolvedSessionAccount,
  RevokeAccountSessions,
  RevokeStoredSession,
  SessionStore,
  SessionAccountResolver,
  SetAuthenticationAccountState,
  StoredSession,
  TouchStoredSession,
} from "./stores.js";
export type {
  AuthenticatedPrincipal,
  AuthenticationAccount,
  AuthenticationAccountState,
  AuthenticationEvidence,
  AuthenticationSubject,
  SubjectProvider,
} from "./types.js";
