// Frontend-owned page paths the auth backend redirects to. Confirm changes with the frontend owner.
// Deliberately not server-only: the frontend may reuse safeReturnPath for its own `next` handling.
export const LOGIN_PATH = "/login";
export const HOME_PATH = "/";
export const RESET_PASSWORD_PATH = "/reset-password";
/** Backend email-confirmation route; must be in the Supabase redirect allowlist. */
export const CONFIRM_PATH = "/auth/confirm";

/** `?error=` values the login page should explain. */
export type LoginError = "confirmation_failed" | "unavailable" | "rate_limited";
/** `?status=` values the login page should acknowledge. */
export type LoginStatus = "email_confirmed";

/** Accept only same-origin absolute paths; reject protocol-relative, backslash, and control-character tricks. */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  const base = "http://return-path.invalid";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname.startsWith("//")) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function loginPath(options: { error?: LoginError; status?: LoginStatus; next?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.error) params.set("error", options.error);
  if (options.status) params.set("status", options.status);
  const next = safeReturnPath(options.next);
  if (next && next !== HOME_PATH) params.set("next", next);
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}
