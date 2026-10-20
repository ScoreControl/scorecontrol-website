import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAuthConfig, getSecretKey } from "./config";
import { AuthHttpError, unavailable, usernameTaken } from "./errors";
import { createAuthDeadline } from "./deadline";
import { emailSchema, usernameSchema, validate } from "./validation";

let admin: { url: string; key: string; client: SupabaseClient } | undefined;

// Never expose this client: its key bypasses RLS. Only the fixed RPCs below may use it.
function adminClient(url: string, key: string): SupabaseClient {
  if (admin?.url !== url || admin.key !== key) {
    admin = { url, key, client: createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    }) };
  }
  return admin.client;
}

async function rpc(name: "auth_resolve_username" | "auth_username_for_user" | "auth_claim_username",
  parameters: Record<string, string>): Promise<unknown> {
  const config = getAuthConfig();
  const key = getSecretKey();
  const deadline = createAuthDeadline();
  const client = adminClient(config.url, key);
  const { data, error } = await deadline.execute(async () => client.rpc(name, parameters).abortSignal(deadline.signal));
  if (error) {
    if (error.code === "23505") throw usernameTaken();
    if (error.code === "23514" || error.code === "22023") throw new AuthHttpError(400, "INVALID_REQUEST", "Choose a valid username.");
    throw unavailable("USERNAME_UNAVAILABLE");
  }
  return data;
}

export async function findUsernameAccount(username: string): Promise<{ id: string; email: string } | null> {
  const result = await rpc("auth_resolve_username", { requested_username: username });
  if (!Array.isArray(result) || result.length > 1) throw unavailable("USERNAME_UNAVAILABLE");
  if (!result.length) return null;
  const row = result[0];
  if (typeof row?.user_id !== "string" || typeof row?.email !== "string") throw unavailable("USERNAME_UNAVAILABLE");
  return { id: row.user_id, email: row.email };
}

/** Null only for accounts created before usernames were required. */
export async function usernameForUser(id: string): Promise<string | null> {
  const value = await rpc("auth_username_for_user", { account_id: id });
  if (value !== null && typeof value !== "string") throw unavailable("USERNAME_UNAVAILABLE");
  return value;
}

export async function claimUsername(id: string, username: string): Promise<string> {
  const value = await rpc("auth_claim_username", { account_id: id, requested_username: username });
  if (typeof value !== "string") throw unavailable("USERNAME_UNAVAILABLE");
  if (value !== username) throw new AuthHttpError(409, "USERNAME_ALREADY_SET", "This account already has a username.");
  return value;
}

type LoginIdentity = { email: string; id?: string };

/** The private mapping is authoritative; mutable auth metadata is never used for lookup. */
export async function resolveLoginIdentity(identifier: string): Promise<LoginIdentity | null> {
  const email = emailSchema.safeParse(identifier);
  if (email.success) return { email: email.data };
  if (!identifier.includes("@")) return findUsernameAccount(validate(usernameSchema, identifier));
  throw new AuthHttpError(400, "INVALID_REQUEST", "Enter a valid email address or username.", { identifier: ["Enter a valid email address or username."] });
}
