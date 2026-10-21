import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createAuthDeadline } from "./deadline";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { usernameForUser } from "./usernames";
import { isInvalidSession, providerError, unauthenticated } from "./errors";
import { loginPath } from "./paths";

/** Provider-verified identity. Guards return this without any username lookup. */
export type AuthIdentity = { id: string; email: string | null; emailVerified: boolean };
export type AuthUser = AuthIdentity & { username: string | null };

function safeUser(user: User): AuthIdentity {
  return { id: user.id, email: user.email ?? null, emailVerified: Boolean(user.email_confirmed_at) };
}

/** Verify the session with the provider. Returns null when signed out; throws on outages. */
export async function getIdentity(client: SupabaseClient): Promise<AuthIdentity | null> {
  const { data, error } = await client.auth.getUser();
  if (error) {
    if (isInvalidSession(error)) return null;
    throw providerError(error);
  }
  return data.user ? safeUser(data.user) : null;
}

// React cache deduplicates only within this render/request, never across users.
const getPageIdentity = cache(async (): Promise<AuthIdentity | null> => {
  const deadline = createAuthDeadline();
  const client = await createReadOnlyClient(deadline.signal);
  return deadline.execute(() => getIdentity(client));
});

/** Route Handlers pass their client; Server Components omit it and use the page request's cookies. */
function identityFor(client?: SupabaseClient): Promise<AuthIdentity | null> {
  return client ? getIdentity(client) : getPageIdentity();
}

/** Full safe user including the display username. */
export async function getCurrentUser(client?: SupabaseClient): Promise<AuthUser | null> {
  const identity = await identityFor(client);
  return identity && withUsername(identity);
}

/**
 * Use inside every protected backend operation. Always derive ownership from the returned ID.
 * Skips the username lookup so protected operations do not depend on the username registry.
 */
export async function requireUser(client?: SupabaseClient): Promise<AuthIdentity> {
  const identity = await identityFor(client);
  if (!identity) throw unauthenticated();
  return identity;
}

/**
 * Page adapter: unauthenticated visitors navigate to the frontend-owned login page.
 * Pass the current path as `returnTo` to send it as a validated `next` parameter.
 */
export async function requirePageUser(returnTo?: string): Promise<AuthIdentity> {
  const identity = await getPageIdentity();
  if (!identity) redirect(loginPath({ next: returnTo }));
  return identity;
}

/** Username is presentation/login identity, never a role or resource ownership key. */
async function withUsername(identity: AuthIdentity): Promise<AuthUser> {
  return { ...identity, username: await usernameForUser(identity.id) };
}

export async function authUser(user: User): Promise<AuthUser> {
  return withUsername(safeUser(user));
}
