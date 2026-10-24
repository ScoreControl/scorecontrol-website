import "server-only";
import { AuthHttpError } from "./errors";

function configurationError(): never {
  throw new AuthHttpError(503, "AUTH_NOT_CONFIGURED", "Authentication setup is incomplete. Check the server environment configuration.");
}

/** HTTPS (or loopback HTTP) origin with no credentials, path, query, or fragment. */
function parseOrigin(value: string | undefined): string {
  try {
    if (!value) return configurationError();
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.pathname !== "/" || url.search || url.hash) {
      return configurationError();
    }
    return url.origin;
  } catch {
    return configurationError();
  }
}

export function getAppOrigin(): string {
  return parseOrigin(process.env.APP_ORIGIN);
}

export function getAuthConfig() {
  
  const origin = getAppOrigin();
  const url = parseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  // Only Supabase's current key formats; legacy JWT anon/service_role keys are rejected.
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!key?.startsWith("sb_publishable_")) return configurationError();
  return { origin, url, key, secureCookies: origin.startsWith("https:") };
}

/** Server-only admin key for the username RPCs. */
export function getSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!key?.startsWith("sb_secret_")) return configurationError();
  return key;
}
