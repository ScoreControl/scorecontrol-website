import "server-only";
import { createEphemeralClient } from "@/lib/supabase/server";
import { createAuthDeadline } from "@/lib/auth/deadline";
import { getIdentity, type AuthIdentity } from "@/lib/auth/user";
import { unauthenticated } from "@/lib/auth/errors";
import { tokenExpired } from "./errors";

/** How the caller authenticated: the plugin sends a bearer token, the web app a cookie session. */
export type ApiCaller = AuthIdentity & { via: "bearer" | "cookie" };

const MAX_TOKEN_LENGTH = 4096;

/**
 * The bearer token from the Authorization header, or null when there is no header.
 * A header that is present but malformed is rejected rather than silently falling back to cookies.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw unauthenticated();
  return match[1];
}

/** Reads `exp` without verifying the signature: only to tell the plugin to refresh, never to trust the token. */
function isExpired(token: string, now = Date.now()): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp * 1000 <= now;
  } catch {
    throw unauthenticated();
  }
}

/**
 * Verifies an access token with Supabase Auth (getUser checks the signature, expiry, and that the
 * session still exists). Throws TOKEN_EXPIRED so the plugin refreshes, UNAUTHENTICATED for any
 * other invalid token, and 503 during provider outages.
 */
export async function verifyAccessToken(token: string, signal?: AbortSignal): Promise<AuthIdentity> {
  if (isExpired(token)) throw tokenExpired();
  const deadline = createAuthDeadline(signal);
  const client = createEphemeralClient(deadline.signal);
  const identity = await deadline.execute(() => getIdentity(client, token));
  if (!identity) throw unauthenticated();
  return identity;
}
