import { defineActionMiddleware } from "../actions/index.js";
import { dep } from "../di/index.js";
import { AuthenticationContext } from "./context.js";
import { AuthenticationRequiredError } from "./errors.js";

/** Protects an Action independently from its current transport. */
export const requireAuthentication = defineActionMiddleware(
  "authentication.required",
  {
    dependencies: {
      authenticationContext: dep<AuthenticationContext<unknown>>(
        "authenticationContext",
      ),
    },
    handler: ({ deps }, next) => {
      if (deps.authenticationContext.getPrincipal() === undefined) {
        throw new AuthenticationRequiredError();
      }

      return next();
    },
  },
);

