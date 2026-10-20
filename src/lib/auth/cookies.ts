import "server-only";
import type { CookieOptions } from "@supabase/ssr";
import type { NextResponse } from "next/server";

export const AUTH_COOKIE = "sc-auth";
export const PERSISTENCE_COOKIE = "sc-auth-persistence";
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
type CookieValue = { name: string; value: string };
type CookieMutation = CookieValue & { options: CookieOptions };

export function isSessionCookie(name: string): boolean {
  return name === AUTH_COOKIE || /^sc-auth\.\d+$/.test(name);
}

function isVerifierCookie(name: string): boolean {
  return name === `${AUTH_COOKIE}-code-verifier` || /^sc-auth-code-verifier\.\d+$/.test(name);
}

function isRemoval(options: CookieOptions): boolean {
  return (options.maxAge !== undefined && options.maxAge <= 0) || Boolean(options.expires && options.expires.getTime() <= Date.now());
}

/** Enforced attributes for every auth cookie: HttpOnly, Lax, root path, host-only. */
function hardened(options: CookieOptions, secure: boolean): CookieOptions {
  const result = { ...options, httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  delete result.domain;
  return result;
}

export function sessionCookieOptions(options: CookieOptions, remember: boolean, secure: boolean): CookieOptions {
  const result = hardened(options, secure);
  // Never turn an SDK cookie removal into a live cookie.
  if (isRemoval(result)) return result;
  delete result.expires;
  if (remember) result.maxAge = REMEMBER_SECONDS;
  else delete result.maxAge;
  return result;
}

export function createCookieBridge(initial: CookieValue[], secure: boolean) {
  let current = new Map(initial.map(({ name, value }) => [name, value]));
  let remember = current.get(PERSISTENCE_COOKIE) === "remember";
  const pending = new Map<string, CookieMutation>();
  const headers = new Headers();
  let retainOnFailure = false;
  let committed: { current: Map<string, string>; pending: Map<string, CookieMutation>; headers: Headers } | undefined;

  function store(mutation: CookieMutation) {
    pending.set(mutation.name, mutation);
    if (isRemoval(mutation.options)) current.delete(mutation.name);
    else current.set(mutation.name, mutation.value);
  }

  return {
    getAll: () => Array.from(current, ([name, value]) => ({ name, value })),
    hasSession: () => Array.from(current.keys()).some(isSessionCookie),
    commitSession() { retainOnFailure = true; },
    setMode(value: boolean) { remember = value; },
    savePreference() {
      store({ name: PERSISTENCE_COOKIE, value: remember ? "remember" : "session",
        options: sessionCookieOptions({}, remember, secure) });
    },
    setAll(mutations: CookieMutation[], cacheHeaders: Record<string, string> = {}) {
      for (const mutation of mutations) {
        const options = isSessionCookie(mutation.name)
          ? sessionCookieOptions(mutation.options, remember, secure)
          : hardened(mutation.options, secure);
        store({ ...mutation, options });
      }
      const liveSessionWrite = mutations.some(({ name, value }) => isSessionCookie(name) && value);
      // Renew the preference only on a live session write, not on verifier writes or removals.
      if (liveSessionWrite) this.savePreference();
      Object.entries(cacheHeaders).forEach(([name, value]) => headers.set(name, value));
      // A live SDK session write has already committed a token rotation at the provider.
      // Keep that credential even if a subsequent identity lookup fails.
      if (liveSessionWrite) committed = { current: new Map(current), pending: new Map(pending), headers: new Headers(headers) };
    },
    clear(includeVerifier = false) {
      const names = new Set([...current.keys(), ...pending.keys(), AUTH_COOKIE, PERSISTENCE_COOKIE]);
      if (includeVerifier) names.add(`${AUTH_COOKIE}-code-verifier`);
      for (const name of names) {
        if (isSessionCookie(name) || name === PERSISTENCE_COOKIE || (includeVerifier && isVerifierCookie(name))) {
          store({ name, value: "", options: sessionCookieOptions({ maxAge: 0 }, false, secure) });
        }
      }
    },
    rollback(preserveSession = false) {
      preserveSession ||= retainOnFailure;
      pending.clear();
      current = preserveSession && committed ? new Map(committed.current) : new Map(initial.map(({ name, value }) => [name, value]));
      remember = current.get(PERSISTENCE_COOKIE) === "remember";
      for (const name of Array.from(headers.keys())) headers.delete(name);
      if (preserveSession && committed) {
        committed.pending.forEach((value, name) => pending.set(name, value));
        committed.headers.forEach((value, name) => headers.set(name, value));
      } else committed = undefined;
    },
    apply<T extends NextResponse>(response: T): T {
      for (const { name, value, options } of pending.values()) response.cookies.set(name, value, options);
      headers.forEach((value, name) => response.headers.set(name, value));
      return response;
    },
  };
}
