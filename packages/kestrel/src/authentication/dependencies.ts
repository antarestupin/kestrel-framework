import { dep } from "../di/index.js";
import type { AuthenticationContext } from "./context.js";
import type { AuthenticationManager } from "./manager.js";
import type {
  PasswordHasher,
} from "./mechanisms/password/types.js";
import type { PasswordMechanism } from "./mechanisms/password/mechanism.js";
import type { AuthenticationAdapter } from "./stores.js";
import type {
  AuthenticationSubject,
  SubjectProvider,
} from "./types.js";

export const authenticationAdapterDependency =
  dep<AuthenticationAdapter>("authenticationAdapter");

export const authenticationContextDependency = <Claims>() =>
  dep<AuthenticationContext<Claims>>("authenticationContext");

export const authenticationManagerDependency = <Claims>() =>
  dep<AuthenticationManager<Claims>>("authenticationManager");

export const authenticationSubjectProviderDependency = <
  Subject extends AuthenticationSubject,
>() => dep<SubjectProvider<Subject>>("authenticationSubjectProvider");

export const passwordHasherDependency =
  dep<PasswordHasher>("passwordHasher");

export const passwordMechanismDependency =
  dep<PasswordMechanism>("passwordMechanism");
