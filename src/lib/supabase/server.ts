import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getAuthConfig } from "@/lib/auth/config";
import { AUTH_COOKIE, createCookieBridge } from "@/lib/auth/cookies";
import { createAuthDeadline } from "@/lib/auth/deadline";
import { AuthHttpError } from "@/lib/auth/errors";

function options(config: ReturnType<typeof getAuthConfig>, signal?: AbortSignal) {
  return {
    cookieOptions: { name: AUTH_COOKIE, httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/" },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const signals = [AbortSignal.timeout(10_000)];
        if (signal) signals.push(signal);
        if (init?.signal) signals.push(init.signal);
        const combined = AbortSignal.any(signals);
        combined.throwIfAborted();
        return fetch(input, { ...init, cache: "no-store", signal: combined });
      },
    },
  };
}

export function createAuthContext(request: NextRequest) {
  const config = getAuthConfig();
  const bridge = createCookieBridge(request.cookies.getAll(), config.secureCookies);
  const deadline = createAuthDeadline(request.signal);
  const client = createServerClient(config.url, config.key, {
    ...options(config, deadline.signal),
    cookies: {
      getAll: bridge.getAll,
      setAll: (values, headers) => { if (!deadline.signal.aborted) bridge.setAll(values, headers); },
    },
  });
  return { client, bridge, execute: deadline.execute };
}

/** In-memory client for one-off provider calls whose session must never reach browser cookies. */
export function createEphemeralClient(signal?: AbortSignal) {
  const config = getAuthConfig();
  return createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: options(config, signal).global,
  });
}

/** Read-only client for Server Components. Proxy handles their session refresh first. */
export async function createReadOnlyClient(signal?: AbortSignal) {
  const config = getAuthConfig();
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    ...options(config, signal),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (mutations) => {
        if (mutations.length) {
          throw new AuthHttpError(503, "SESSION_REFRESH_REQUIRED", "Reload the page to refresh your session.");
        }
      },
    },
  });
}

export type AuthContext = ReturnType<typeof createAuthContext>;
