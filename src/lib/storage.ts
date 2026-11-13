import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAuthConfig, getSecretKey } from "@/lib/auth/config";
import { apiError } from "@/lib/api/errors";

/**
 * Score file bytes in the private `blobs` bucket (supabase/migrations/20261105000000_blobs_bucket.sql),
 * one object per blob at `{projectId}/{sha256}`. Uses the secret key, so callers must check the
 * project role first; the bucket has no policies for anon or signed-in clients.
 */
export const BLOBS_BUCKET = "blobs";
export const blobPath = (projectId: string, sha256: string) => `${projectId}/${sha256}`;

let cached: { url: string; key: string; client: SupabaseClient } | undefined;
function storageClient(): SupabaseClient {
  const { url } = getAuthConfig();
  const key = getSecretKey();
  if (cached?.url !== url || cached.key !== key) {
    cached = { url, key, client: createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    }) };
  }
  return cached.client;
}

const unavailable = () => apiError("SERVICE_UNAVAILABLE", "File storage is unavailable. Try again shortly.");

export async function downloadBlob(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await storageClient().storage.from(BLOBS_BUCKET).download(storagePath);
  if (error || !data) throw unavailable();
  return new Uint8Array(await data.arrayBuffer());
}

/** Idempotent: blobs are content-addressed, so an existing object already holds these bytes. */
export async function uploadBlob(storagePath: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await storageClient().storage.from(BLOBS_BUCKET).upload(storagePath, bytes, { contentType, upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw unavailable();
}
