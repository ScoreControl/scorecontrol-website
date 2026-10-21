import "server-only";

export class AuthHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AuthHttpError";
  }
}

export function unavailable(code = "AUTH_UNAVAILABLE") {
  return new AuthHttpError(503, code, "Authentication is temporarily unavailable. Please try again.");
}

export function unauthenticated() {
  return new AuthHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
}

export function invalidCredentials() {
  return new AuthHttpError(401, "INVALID_CREDENTIALS", "Invalid email/username or password.");
}

export function usernameTaken() {
  return new AuthHttpError(409, "USERNAME_TAKEN", "That username is already taken.");
}

export function rateLimited(retryAfter?: number) {
  return new AuthHttpError(429, "RATE_LIMITED", "Too many attempts. Please wait before trying again.", undefined, retryAfter);
}

function details(error: unknown): { status?: number; code?: string; name?: string } {
  return typeof error === "object" && error !== null ? error : {};
}

export function isInvalidSession(error: unknown): boolean {
  const { status, code, name } = details(error);
  return status === 401 || status === 403 || name === "AuthSessionMissingError" ||
    name === "AuthInvalidJwtError" || [
      "bad_jwt", "user_not_found", "user_banned", "session_not_found", "session_expired",
      "refresh_token_not_found", "refresh_token_already_used", "unexpected_audience",
    ].includes(code ?? "");
}

export function providerError(error: unknown): AuthHttpError {
  const { status, code, name } = details(error);
  if (status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return rateLimited();
  }
  if (!status || status >= 500 || name === "AuthRetryableFetchError") return unavailable();
  if (code === "invalid_credentials") return invalidCredentials();
  if (code === "email_not_confirmed") {
    return new AuthHttpError(403, "EMAIL_NOT_CONFIRMED", "Confirm your email before signing in.");
  }
  if (code === "weak_password") {
    return new AuthHttpError(400, "WEAK_PASSWORD", "Choose a password that meets the account password requirements.");
  }
  if (code === "signup_disabled" || code === "email_provider_disabled") return unavailable("AUTH_NOT_CONFIGURED");
  return new AuthHttpError(400, "AUTH_REQUEST_FAILED", "The authentication request could not be completed.");
}

export function isDuplicateAccount(error: unknown): boolean {
  return ["user_already_exists", "email_exists"].includes(details(error).code ?? "");
}
