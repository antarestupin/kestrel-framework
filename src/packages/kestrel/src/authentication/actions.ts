import { z, type ZodType } from "zod";

import { defineAction } from "../actions/index.js";
import { dep } from "../di/index.js";
import type { AuthenticationDefinition } from "./definition.js";
import { AuthenticationContext } from "./context.js";
import { InvalidCredentialsError } from "./errors.js";
import type { AuthenticationAttemptGuard } from "./attempt_guard.js";
import { AuthenticationManager } from "./manager.js";
import { PasswordMechanism } from "./mechanisms/password/index.js";
import type {
  AuthenticationSubject,
  AuthenticatedPrincipal,
} from "./types.js";

export const passwordSignInInputSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1_024),
  metadata: z.object({
    ipAddress: z.string().max(256).optional(),
    userAgent: z.string().max(1_024).optional(),
  }).optional(),
});

export const passwordSignInHttpInputSchema = passwordSignInInputSchema.omit({
  metadata: true,
});

const emptyAuthenticationInputSchema = z.object({});

/** Authentication use cases and schemas specialized by application claims. */
export function createAuthenticationActions<
  Subject extends AuthenticationSubject,
  Claims,
>(definition: AuthenticationDefinition<Subject, Claims>) {
  const principalSchema = createPrincipalSchema(
    definition.sessionClaims.schema,
  );
  const sessionGrantSchema = z.object({
    token: z.string().min(1),
    principal: principalSchema,
  });
  const currentSessionSchema = z.discriminatedUnion("authenticated", [
    z.object({ authenticated: z.literal(false) }),
    z.object({
      authenticated: z.literal(true),
      principal: principalSchema,
    }),
  ]);

  const signInWithPassword = defineAction({
    name: "authentication.sign-in.password",
    description: "Authenticate an account with a username and password.",
    input: passwordSignInInputSchema,
    output: sessionGrantSchema,
    dependencies: {
      attemptGuard: dep<AuthenticationAttemptGuard>(
        "authenticationAttemptGuard",
      ),
      authenticationManager: dep<AuthenticationManager<Claims>>(
        "authenticationManager",
      ),
      passwordMechanism: dep<PasswordMechanism>("passwordMechanism"),
    },
    handler: async (input, dependencies) => {
      const result = await dependencies.attemptGuard.run(
        {
          credentials: input,
          ...(input.metadata === undefined
            ? {}
            : {
                metadata: {
                  ...(input.metadata.ipAddress === undefined
                    ? {}
                    : { ipAddress: input.metadata.ipAddress }),
                  ...(input.metadata.userAgent === undefined
                    ? {}
                    : { userAgent: input.metadata.userAgent }),
                },
              }),
        },
        () => dependencies.passwordMechanism.authenticate(input),
      );

      if (result.status === "rejected") {
        throw new InvalidCredentialsError();
      }

      const grant = await dependencies.authenticationManager.complete(
        result.proof,
        input.metadata === undefined
          ? undefined
          : {
              ...(input.metadata.ipAddress === undefined
                ? {}
                : { ipAddress: input.metadata.ipAddress }),
              ...(input.metadata.userAgent === undefined
                ? {}
                : { userAgent: input.metadata.userAgent }),
            },
      );

      if (grant === undefined) {
        throw new InvalidCredentialsError();
      }

      return grant;
    },
  });

  const signOut = defineAction({
    name: "authentication.sign-out",
    description: "Revoke the current session when one is available.",
    input: emptyAuthenticationInputSchema,
    dependencies: {
      authenticationContext: dep<AuthenticationContext<Claims>>(
        "authenticationContext",
      ),
      authenticationManager: dep<AuthenticationManager<Claims>>(
        "authenticationManager",
      ),
    },
    handler: async (_input, dependencies) => {
      const principal = dependencies.authenticationContext.getPrincipal();

      if (principal !== undefined) {
        await dependencies.authenticationManager.revokeSession(
          principal.sessionId,
        );
      }

      return null;
    },
  });

  const getCurrentSession = defineAction({
    name: "authentication.current-session",
    description: "Return the current authenticated principal when available.",
    input: emptyAuthenticationInputSchema,
    output: currentSessionSchema,
    dependencies: {
      authenticationContext: dep<AuthenticationContext<Claims>>(
        "authenticationContext",
      ),
    },
    handler: (_input, { authenticationContext }) => {
      const principal = authenticationContext.getPrincipal();

      return principal === undefined
        ? { authenticated: false as const }
        : { authenticated: true as const, principal };
    },
  });

  return {
    actions: {
      signInWithPassword,
      signOut,
      getCurrentSession,
    },
    schemas: {
      principal: principalSchema,
      sessionGrant: sessionGrantSchema,
      currentSession: currentSessionSchema,
    },
  };
}

function createPrincipalSchema<Claims>(
  claimsSchema: ZodType<Claims>,
): ZodType<AuthenticatedPrincipal<Claims>> {
  return z.object({
    accountId: z.string().min(1),
    subjectId: z.string().min(1),
    sessionId: z.string().min(1),
    claims: claimsSchema,
    authentication: z.object({
      methods: z.array(z.string().min(1)).readonly(),
      factors: z.array(z.string().min(1)).readonly(),
      authenticatedAt: z.date(),
    }),
  });
}
