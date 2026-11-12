import { expect, it } from "vitest";

import {
  AuthenticationRateLimitedError,
  AuthenticationRequiredError,
  InvalidCredentialsError,
  UntrustedAuthenticationOriginError,
} from "./errors.js";

it.each([
  [InvalidCredentialsError, "InvalidCredentialsError", 401, "Unauthorized", "The supplied credentials are invalid."],
  [AuthenticationRequiredError, "AuthenticationRequiredError", 401, "Unauthorized", "Authentication is required."],
  [UntrustedAuthenticationOriginError, "UntrustedAuthenticationOriginError", 403, "Forbidden", "The request origin is not trusted."],
  [AuthenticationRateLimitedError, "AuthenticationRateLimitedError", 429, "Too Many Requests", "Too many authentication attempts."],
] as const)("publishes stable application and HTTP details for %s", (ErrorClass, name, statusCode, error, message) => {
  const failure = new ErrorClass();
  expect(failure).toBeInstanceOf(Error);
  expect(failure.name).toBe(name);
  expect(failure.message).toBe(message);
  expect(failure.toHttpError({ executionId: "authentication-test" })).toEqual({ statusCode, error, message });
});
