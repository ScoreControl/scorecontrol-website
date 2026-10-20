import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEphemeralClient } from "@/lib/supabase/server";
import { createAuthDeadline } from "./deadline";
import { AuthHttpError, providerError } from "./errors";

type Execute = <T>(operation: () => Promise<T>) => Promise<T>;

/** Recovery links (PKCE `recovery`, token-hash `otp`) prove email control; allow a password set shortly after. */
const EMAIL_PROOF_WINDOW_SECONDS = 15 * 60;
const EMAIL_PROOF_METHODS = new Set(["recovery", "otp"]);

const invalidCurrentPassword = () => new AuthHttpError(400, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.",
  { currentPassword: ["Your current password is incorrect."] });
export const reauthenticationRequired = () =>
  new AuthHttpError(403, "REAUTHENTICATION_REQUIRED", "Request a password reset email to change your password.");

/** Decode (without verifying) a JWT payload; undefined for malformed values. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload === "object" && payload !== null ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads AMR from the session's access token. Call only after getIdentity() has verified that same
 * session with the provider in this request; the token is then known to be authentic and current.
 */
export async function hasRecentEmailProof(client: SupabaseClient, execute: Execute): Promise<boolean> {
  const { data } = await execute(() => client.auth.getSession());
  const amr = data.session && decodeJwtPayload(data.session.access_token)?.amr;
  const now = Date.now() / 1000;
  return Array.isArray(amr) && amr.some((entry) => typeof entry === "object" && entry !== null &&
    EMAIL_PROOF_METHODS.has(entry.method) && typeof entry.timestamp === "number" &&
    entry.timestamp <= now + 60 && now - entry.timestamp <= EMAIL_PROOF_WINDOW_SECONDS);
}

/** Check the current password without touching browser cookies; the extra provider session is revoked. */
export async function verifyCurrentPassword(email: string, password: string, userId: string, parent?: AbortSignal) {
  const deadline = createAuthDeadline(parent);
  const client = createEphemeralClient(deadline.signal);
  const { data, error } = await deadline.execute(() => client.auth.signInWithPassword({ email, password }));
  if (error) throw error.code === "invalid_credentials" ? invalidCurrentPassword() : providerError(error);
  // Best effort: the in-memory session is discarded either way.
  await deadline.execute(() => client.auth.signOut({ scope: "local" })).catch(() => undefined);
  if (data.user?.id !== userId) throw invalidCurrentPassword();
}

/** Update the signed-in user's password, then revoke their other sessions. */
export async function updatePassword(client: SupabaseClient, execute: Execute, password: string) {
  const { error } = await execute(() => client.auth.updateUser({ password }));
  if (error) {
    if (error.code === "same_password") {
      throw new AuthHttpError(400, "SAME_PASSWORD", "Choose a password different from your current one.",
        { password: ["Choose a password different from your current one."] });
    }
    if (error.code === "reauthentication_needed" || error.code === "reauthentication_not_valid") throw reauthenticationRequired();
    throw providerError(error);
  }
  const revoked = await execute(() => client.auth.signOut({ scope: "others" })).then(({ error }) => !error, () => false);
  return { status: "password_updated" as const, otherSessionsRevoked: revoked };
}
